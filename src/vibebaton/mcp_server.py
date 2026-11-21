"""Zero-dependency MCP stdio server exposing VibeBaton's async control plane to Antigravity."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from . import __version__
from .cli_runner import check_provider_binary
from .config import HotReloadConfig, find_config_path
from .db import StateStore
from .git_ops import get_diff_against
from .report import generate_battle_report
from .schemas import RunStatus, TaskStatus


def _spawn_detached_daemon(repo_path: Path, config_path: Path, run_id: str) -> int:
    """Launch `vibebaton daemon` completely detached from the MCP server lifecycle."""
    cmd = [
        sys.executable,
        "-m",
        "vibebaton",
        "daemon",
        "--repo",
        str(repo_path),
        "--config",
        str(config_path),
        "--run-id",
        run_id,
    ]
    log_dir = repo_path / ".baton" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = open(log_dir / f"{run_id}.daemon.log", "a", encoding="utf-8")

    creationflags = 0
    if sys.platform == "win32":
        creationflags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP

    proc = subprocess.Popen(
        cmd,
        cwd=str(repo_path),
        stdin=subprocess.DEVNULL,
        stdout=log_file,
        stderr=log_file,
        creationflags=creationflags,
        start_new_session=(sys.platform != "win32"),
    )
    log_file.close()
    return proc.pid


class VibeBatonMCPServer:
    """Thin MCP control plane backed by SQLite WAL + detached background daemon."""

    TOOLS: list[dict[str, Any]] = [
        {
            "name": "baton_health",
            "description": "Check local CLI providers (claude, codex, opencode), config validity, and provider cooldown status.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "repo_path": {"type": "string", "description": "Target git repository path (defaults to cwd)."}
                },
            },
        },
        {
            "name": "baton_start",
            "description": "Start a VibeBaton pipeline asynchronously from a Master RFC markdown file. Returns run_id immediately while background daemon executes.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "repo_path": {"type": "string", "description": "Target git repository path."},
                    "rfc_path": {"type": "string", "description": "Path to 00_RFC.md."},
                    "plan_path": {"type": "string", "description": "Optional pre-built 01_PLAN.dag.json path."},
                    "mode": {"type": "string", "enum": ["interactive", "overnight"], "default": "overnight"},
                    "model_overrides": {
                        "type": "object",
                        "description": "Optional per-role model overrides, e.g. {'bulk_worker': 'deepseek-flash-v5'}.",
                    },
                },
                "required": ["repo_path", "rfc_path"],
            },
        },
        {
            "name": "baton_status",
            "description": "Query current DAG status, milestones, tasks, and provider subscription cooldown windows.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "repo_path": {"type": "string"},
                    "run_id": {"type": "string", "description": "Optional run_id (defaults to latest run)."},
                },
            },
        },
        {
            "name": "baton_logs",
            "description": "Fetch recent audit events, mechanical gate errors, and review verdicts for a run or task.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "repo_path": {"type": "string"},
                    "run_id": {"type": "string"},
                    "task_id": {"type": "string"},
                    "limit": {"type": "integer", "default": 40},
                },
            },
        },
        {
            "name": "baton_resolve",
            "description": "Submit a human decision (approve/reject) for a WAITING_HUMAN run and resume background execution.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "repo_path": {"type": "string"},
                    "run_id": {"type": "string"},
                    "decision": {"type": "string", "enum": ["approve", "reject"]},
                    "note": {"type": "string", "default": ""},
                },
                "required": ["run_id", "decision"],
            },
        },
        {
            "name": "baton_control",
            "description": "Pause, resume, or manually escalate a task to the specialist tier.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "repo_path": {"type": "string"},
                    "run_id": {"type": "string"},
                    "action": {"type": "string", "enum": ["pause", "resume", "escalate_task"]},
                    "task_id": {"type": "string"},
                },
                "required": ["run_id", "action"],
            },
        },
        {
            "name": "baton_final_package",
            "description": "Assemble the final gate review package (battle report, milestone reviews, and git diff against base branch) for L0 sign-off.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "repo_path": {"type": "string"},
                    "run_id": {"type": "string"},
                },
            },
        },
        {
            "name": "baton_list_presets",
            "description": "List workflow presets with their validation results.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "directory": {"type": "string", "description": "Override the default presets directory."},
                },
            },
        },
        {
            "name": "baton_validate_graph",
            "description": "Validate a workflow graph and optionally simulate it with mock handlers.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "graph_path": {
                        "type": "string",
                        "description": "Preset ID or graph file path. Used when both graph inputs are supplied.",
                    },
                    "graph_json": {"type": ["string", "object"], "description": "Graph as a JSON string or object."},
                    "simulate_scenario": {"type": "string", "enum": ["happy_path", "gate_retry", "escalate"]},
                },
                "anyOf": [{"required": ["graph_path"]}, {"required": ["graph_json"]}],
            },
        },
    ]

    def __init__(self, default_repo: Path | None = None, explicit_config: Path | None = None) -> None:
        self.default_repo = (default_repo or Path.cwd()).resolve()
        self.explicit_config = explicit_config.resolve() if explicit_config else None

    def _context(self, args: dict[str, Any]) -> tuple[Path, Path, HotReloadConfig, StateStore]:
        repo = Path(args["repo_path"]).resolve() if args.get("repo_path") else self.default_repo
        cfg_path = find_config_path(repo, explicit=self.explicit_config)
        loader = HotReloadConfig(cfg_path)
        db_rel = Path(loader.current.daemon.db_path)
        db_path = db_rel if db_rel.is_absolute() else (repo / db_rel)
        return repo, cfg_path, loader, StateStore(db_path)

    def dispatch_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        if name == "baton_list_presets":
            from .presets import list_presets, validate_all_presets

            directory = args.get("directory")
            summaries = list_presets(directory)
            validation_by_id = validate_all_presets(directory)
            presets: list[dict[str, Any]] = []
            for summary in summaries:
                validation = validation_by_id[summary.id]
                presets.append(
                    {
                        **summary.to_dict(),
                        "valid": validation.valid,
                        "errors": validation.errors,
                        "warnings": validation.warnings,
                    }
                )
            return {"presets": presets, "count": len(presets)}

        if name == "baton_validate_graph":
            from .graph_engine import simulate_graph
            from .graph_schema import WorkflowGraph, validate_graph
            from .presets import load_preset

            try:
                if "graph_path" in args:
                    graph = load_preset(args["graph_path"])
                elif "graph_json" in args:
                    graph_json = args["graph_json"]
                    graph = WorkflowGraph.from_dict(
                        json.loads(graph_json) if isinstance(graph_json, str) else graph_json
                    )
                else:
                    raise ValueError("Provide graph_path or graph_json.")
            except (OSError, TypeError, ValueError) as exc:
                return {
                    "valid": False,
                    "errors": [str(exc)],
                    "warnings": [],
                    "entry_nodes": [],
                    "has_cycles": False,
                }

            validation = validate_graph(graph)
            result: dict[str, Any] = {
                "valid": validation.valid,
                "errors": validation.errors,
                "warnings": validation.warnings,
                "entry_nodes": validation.entry_nodes,
                "has_cycles": validation.has_cycles,
            }
            if validation.valid and "simulate_scenario" in args:
                simulation = simulate_graph(graph, args["simulate_scenario"])
                result["simulation"] = {
                    "status": simulation.status,
                    "visited_nodes": simulation.visited_nodes,
                    "trace": [event.to_dict() for event in simulation.trace],
                }
            return result

        repo, cfg_path, loader, store = self._context(args)
        cfg = loader.current

        if name == "baton_health":
            checks = [check_provider_binary(p) for p in cfg.providers.values()]
            return {
                "version": __version__,
                "repo": str(repo),
                "config_path": str(cfg_path),
                "providers": checks,
                "quotas": store.get_all_quotas(),
                "roles": {
                    r.name: {"provider": r.provider, "model": r.model}
                    for r in cfg.roles.values()
                },
            }

        if name == "baton_start":
            rfc = Path(args["rfc_path"])
            if not rfc.is_absolute():
                rfc = (repo / rfc).resolve()
            if not rfc.exists():
                raise FileNotFoundError(f"RFC file not found: {rfc}")
            plan = Path(args["plan_path"]).resolve() if args.get("plan_path") else None
            run_id = store.create_run(
                repo_path=repo,
                rfc_path=rfc,
                plan_path=plan,
                mode=str(args.get("mode", "overnight")),
                model_overrides=args.get("model_overrides") or {},
            )
            pid = _spawn_detached_daemon(repo, cfg_path, run_id)
            store.log_event(run_id, "daemon_spawned", message=f"Detached daemon started (pid={pid})")
            return {
                "run_id": run_id,
                "daemon_pid": pid,
                "status": "STARTED",
                "message": f"Pipeline '{run_id}' dispatched to detached background daemon (pid={pid}).",
            }

        if name == "baton_status":
            run = store.get_run(args["run_id"]) if args.get("run_id") else store.get_latest_run()
            if not run:
                return {"error": "No runs found in state store."}
            rid = run["id"]
            return {
                "run": run,
                "milestones": store.get_milestones(rid),
                "tasks": store.get_tasks(rid),
                "quotas": store.get_all_quotas(),
            }

        if name == "baton_logs":
            run = store.get_run(args["run_id"]) if args.get("run_id") else store.get_latest_run()
            if not run:
                return {"error": "No runs found."}
            events = store.get_events(
                run["id"],
                task_id=args.get("task_id"),
                limit=int(args.get("limit", 40)),
            )
            return {"run_id": run["id"], "events": events}

        if name == "baton_resolve":
            rid = str(args["run_id"])
            decision = str(args["decision"])
            note = str(args.get("note", ""))
            store.record_human_decision(rid, decision, note)
            pid = None
            if decision == "approve":
                pid = _spawn_detached_daemon(repo, cfg_path, rid)
            return {"run_id": rid, "decision": decision, "resumed_daemon_pid": pid}

        if name == "baton_control":
            rid = str(args["run_id"])
            action = str(args["action"])
            if action == "pause":
                store.update_run_status(rid, RunStatus.PAUSED, summary="Paused by user/host")
                return {"run_id": rid, "status": "PAUSED"}
            if action == "resume":
                store.update_run_status(rid, RunStatus.RUNNING)
                pid = _spawn_detached_daemon(repo, cfg_path, rid)
                return {"run_id": rid, "status": "RESUMED", "daemon_pid": pid}
            if action == "escalate_task":
                tid = str(args.get("task_id", ""))
                task = store.get_task(rid, tid)
                if not task:
                    raise ValueError(f"Task '{tid}' not found in run '{rid}'")
                spec = json.loads(task["spec_json"])
                target_role = spec.get("escalate_role", "critical_executor")
                store.update_task(rid, tid, current_role=target_role, escalated=1, status=TaskStatus.PENDING)
                store.log_event(rid, "manual_escalation", task_id=tid, message=f"Manually escalated to {target_role}")
                return {"run_id": rid, "task_id": tid, "escalated_to": target_role}
            raise ValueError(f"Unsupported control action: {action}")

        if name == "baton_final_package":
            run = store.get_run(args["run_id"]) if args.get("run_id") else store.get_latest_run()
            if not run:
                return {"error": "No runs found."}
            rid = run["id"]
            report_md = generate_battle_report(store, rid)
            diff_text = get_diff_against(
                repo,
                base_ref=cfg.daemon.base_branch,
                head_ref=cfg.daemon.dev_branch,
                max_chars=30000,
            )
            return {
                "run_id": rid,
                "status": run["status"],
                "battle_report_markdown": report_md,
                "milestones": store.get_milestones(rid),
                "diff_dev_vs_base": diff_text,
            }

        raise ValueError(f"Unknown tool: {name}")

    def handle_request(self, req: dict[str, Any]) -> dict[str, Any] | None:
        method = req.get("method", "")
        req_id = req.get("id")
        params = req.get("params") or {}

        # JSON-RPC notifications have no id and expect no reply
        if req_id is None:
            return None

        try:
            if method == "initialize":
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "vibebaton", "version": __version__},
                    },
                }
            if method == "ping":
                return {"jsonrpc": "2.0", "id": req_id, "result": {}}
            if method == "tools/list":
                return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": self.TOOLS}}
            if method == "tools/call":
                tool_name = str(params.get("name", ""))
                tool_args = params.get("arguments") or {}
                payload = self.dispatch_tool(tool_name, tool_args)
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "content": [
                            {"type": "text", "text": json.dumps(payload, indent=2, ensure_ascii=False)}
                        ],
                        "isError": False,
                    },
                }
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32601, "message": f"Method not found: {method}"},
            }
        except Exception as exc:
            if method == "tools/call":
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "content": [{"type": "text", "text": f"Error: {exc}"}],
                        "isError": True,
                    },
                }
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32000, "message": str(exc)},
            }

    def serve_stdio(self) -> None:
        """Serve newline-delimited JSON-RPC 2.0 MCP messages on stdin/stdout."""
        for raw_line in sys.stdin:
            line = raw_line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except json.JSONDecodeError:
                continue
            resp = self.handle_request(req)
            if resp is not None:
                sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
                sys.stdout.flush()
