"""VibeBaton CLI (`baton`): doctor, init, run, daemon, status, resolve, report, mcp, promote-seed."""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import shutil
import subprocess
import sys
import webbrowser
from dataclasses import replace
from pathlib import Path

from . import __version__
from .cli_runner import check_provider_binary, run_provider_cli
from .config import HotReloadConfig, find_config_path, parse_config_dict
from .credentials import default_credentials_path
from .db import StateStore
from .engine import OrchestrationEngine
from .mcp_server import VibeBatonMCPServer, _spawn_detached_daemon
from .notifier import AttentionEvent, AttentionNotifier, mask_webhook_url
from .report import generate_battle_report


def _package_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _resolve_store(repo: Path, config_path: Path) -> tuple[HotReloadConfig, StateStore]:
    loader = HotReloadConfig(config_path)
    db_rel = Path(loader.current.daemon.db_path)
    db_path = db_rel if db_rel.is_absolute() else (repo / db_rel)
    return loader, StateStore(db_path)


def cmd_init(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    baton_dir = repo / ".baton"
    baton_dir.mkdir(parents=True, exist_ok=True)
    target_cfg = baton_dir / "baton.toml"
    example_cfg = _package_root() / "baton.example.toml"

    if target_cfg.exists() and not args.force:
        print(f"[skip] Config already exists: {target_cfg} (use --force to overwrite)")
    else:
        shutil.copy2(example_cfg, target_cfg)
        print(f"[ok] Created config: {target_cfg}")

    rfc_template = baton_dir / "00_RFC.md"
    if not rfc_template.exists():
        rfc_template.write_text(
            "# Master RFC (00_RFC.md)\n\n"
            "## 1. Goal\nDescribe what you want VibeBaton to build.\n\n"
            "## 2. Constraints & Non-Goals\n- Tech stack:\n- Out of scope:\n\n"
            "## 3. Acceptance Criteria\n- [ ] All tests pass\n",
            encoding="utf-8",
        )
        print(f"[ok] Created starter RFC: {rfc_template}")

    print("\nNext steps:")
    print(f"  1. Review/edit {target_cfg}")
    print(f"  2. Run: baton doctor --repo \"{repo}\"")
    return 0


def cmd_doctor(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    cfg_path = find_config_path(repo, explicit=Path(args.config) if args.config else None)
    loader, store = _resolve_store(repo, cfg_path)
    cfg = loader.current

    print(f"VibeBaton Doctor v{__version__}")
    print(f"  Repo   : {repo}")
    print(f"  Config : {cfg_path}")
    print(f"  Python : {sys.version.split()[0]}")

    git_ok = shutil.which("git") is not None
    print(f"  Git    : {'OK' if git_ok else 'MISSING'}")

    print("\nProviders:")
    all_ok = git_ok
    for pname, pcfg in cfg.providers.items():
        res = check_provider_binary(pcfg)
        badge = "OK  " if res["ok"] else "MISS"
        print(f"  [{badge}] {pname:<14} cmd={res['binary']:<10} concurrency={pcfg.max_concurrency}  ({res['detail']})")
        if not res["ok"]:
            all_ok = False

    print("\nRole Routing:")
    for rname, rcfg in cfg.roles.items():
        fb = ", ".join(f"{f.provider}:{f.model}" for f in rcfg.fallback) or "-"
        print(f"  - {rname:<26} -> {rcfg.provider}:{rcfg.model}  (fallback: {fb})")

    if args.role:
        role_cfg, prov_cfg = cfg.resolve_role(args.role)
        if prov_cfg is None:
            print(f"\n[info] Role '{args.role}' is host_native (no CLI smoke test needed).")
            return 0
        print(f"\nRunning live smoke test for role '{args.role}' ({prov_cfg.name}/{role_cfg.model})...")
        smoke_dir = repo / ".baton" / "doctor_smoke"
        res = asyncio.run(
            run_provider_cli(
                prov_cfg,
                model=role_cfg.model,
                prompt='Respond ONLY with this exact JSON object: {"status": "ok"}',
                workdir=repo,
                prompt_file=smoke_dir / f"{args.role}.prompt.md",
                output_file=smoke_dir / f"{args.role}.out.json",
                default_stall_timeout=60,
                default_hard_timeout=90,
            )
        )
        print(f"  Smoke Result: status={res.status} exit={res.exit_code} duration={res.duration_sec:.2f}s")
        preview = (res.output_file_text or res.stdout).strip()
        if res.status == "ok" and preview:
            print(f"  OUTPUT: {preview[:200]}")
        if res.status != "ok":
            print(f"  STDERR: {res.stderr.strip()[-600:]}")
            return 1

    quotas = store.get_all_quotas()
    if quotas:
        print("\nQuota Cooldowns:")
        for q in quotas:
            print(f"  - {q['provider']}: remaining={q['remaining_sec']:.0f}s hits={q['cooldown_hits']}")

    return 0 if all_ok else 1


def _parse_overrides(pairs: list[str] | None) -> dict[str, str]:
    overrides: dict[str, str] = {}
    for item in pairs or []:
        if "=" not in item:
            raise ValueError(f"Invalid --override '{item}'; expected role=model or role=provider:model")
        k, v = item.split("=", 1)
        overrides[k.strip()] = v.strip()
    return overrides


def cmd_run(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    cfg_path = find_config_path(repo, explicit=Path(args.config) if args.config else None)
    loader, store = _resolve_store(repo, cfg_path)

    rfc_path = Path(args.rfc)
    if not rfc_path.is_absolute():
        rfc_path = (repo / rfc_path).resolve()
    plan_path = Path(args.plan).resolve() if args.plan else None

    overrides = _parse_overrides(args.override)
    run_id = store.create_run(
        repo_path=repo,
        rfc_path=rfc_path,
        plan_path=plan_path,
        mode=args.mode,
        model_overrides=overrides,
    )

    if args.detach:
        pid = _spawn_detached_daemon(repo, cfg_path, run_id)
        print(f"[ok] Detached background run started: run_id={run_id} pid={pid}")
        return 0

    engine = OrchestrationEngine(repo_path=repo, config_loader=loader, store=store)
    status = asyncio.run(engine.execute_run(run_id))
    print(f"[done] run_id={run_id} final_status={status.value}")
    return 0 if status.value in ("READY_FOR_FINAL_GATE", "COMPLETED") else 1


def cmd_daemon(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    cfg_path = find_config_path(repo, explicit=Path(args.config) if args.config else None)
    loader, store = _resolve_store(repo, cfg_path)
    engine = OrchestrationEngine(repo_path=repo, config_loader=loader, store=store)
    status = asyncio.run(engine.execute_run(args.run_id))
    return 0 if status.value in ("READY_FOR_FINAL_GATE", "COMPLETED", "WAITING_HUMAN", "PAUSED") else 1


def cmd_status(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    cfg_path = find_config_path(repo, explicit=Path(args.config) if args.config else None)
    _, store = _resolve_store(repo, cfg_path)
    run = store.get_run(args.run_id) if args.run_id else store.get_latest_run()
    if not run:
        print("No runs recorded yet.")
        return 0
    rid = run["id"]
    if args.json:
        print(
            json.dumps(
                {
                    "run": run,
                    "milestones": store.get_milestones(rid),
                    "tasks": store.get_tasks(rid),
                    "quotas": store.get_all_quotas(),
                },
                indent=2,
                ensure_ascii=False,
            )
        )
        return 0

    print(f"Run: {rid}  status={run['status']}  mode={run['mode']}")
    if run.get("summary"):
        print(f"Summary: {run['summary']}")
    for m in store.get_milestones(rid):
        print(f"\n  Milestone {m['id']} [{m['status']}] — {m['title']} ({m['branch_name']})")
        for t in store.get_tasks(rid, milestone_id=m["id"]):
            esc = " [ESCALATED]" if t["escalated"] else ""
            print(
                f"    - {t['id']} [{t['status']:<13}] ({t['tier']}/{t['current_role']}){esc} {t['title']}"
            )
    return 0


def cmd_resolve(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    cfg_path = find_config_path(repo, explicit=Path(args.config) if args.config else None)
    _, store = _resolve_store(repo, cfg_path)
    store.record_human_decision(args.run_id, args.decision, args.note)
    print(f"[ok] Recorded '{args.decision}' for run {args.run_id}")
    if args.decision == "approve" and args.resume:
        pid = _spawn_detached_daemon(repo, cfg_path, args.run_id)
        print(f"[ok] Resumed detached daemon (pid={pid})")
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    cfg_path = find_config_path(repo, explicit=Path(args.config) if args.config else None)
    _, store = _resolve_store(repo, cfg_path)
    run = store.get_run(args.run_id) if args.run_id else store.get_latest_run()
    if not run:
        print("No runs found.")
        return 1
    md = generate_battle_report(store, run["id"])
    if args.out:
        out_path = Path(args.out).resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(md, encoding="utf-8")
        print(f"[ok] Wrote battle report to {out_path}")
    else:
        print(md)
    return 0


def cmd_mcp(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve() if args.repo else Path.cwd().resolve()
    cfg = Path(args.config).resolve() if args.config else None
    server = VibeBatonMCPServer(default_repo=repo, explicit_config=cfg)
    server.serve_stdio()
    return 0


def cmd_promote_seed(args: argparse.Namespace) -> int:
    """Export an immutable snapshot of VibeBaton into a separate runner dir for safe self-hosting."""
    src_root = _package_root()
    dest = Path(args.dest).resolve()
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True, exist_ok=True)
    for item in ("src", "prompts", "presets", "pyproject.toml", "baton.example.toml", "LICENSE"):
        src_path = src_root / item
        if src_path.is_dir():
            shutil.copytree(
                src_path,
                dest / item,
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
            )
        elif src_path.exists():
            shutil.copy2(src_path, dest / item)
    print(f"[ok] Immutable bootstrap runner promoted to: {dest}")
    print(f"     Invoke safely via: PYTHONPATH=\"{dest / 'src'}\" python -m vibebaton ...")
    return 0


def cmd_presets(args: argparse.Namespace) -> int:
    """List workflow presets and optionally report validation for each one."""
    from .presets import list_presets, validate_all_presets

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")

    try:
        summaries = list_presets()
        validations = validate_all_presets() if args.validate else {}
    except (OSError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    if args.json:
        rows = []
        for summary in summaries:
            row = summary.to_dict()
            if args.validate:
                validation = validations[summary.id]
                row.update(
                    valid=validation.valid, errors=validation.errors, warnings=validation.warnings
                )
            rows.append(row)
        print(json.dumps(rows, indent=2))
    else:
        id_width = max([len("ID"), *(len(summary.id) for summary in summaries)])
        difficulty_width = max([len("Difficulty"), *(len(summary.difficulty) for summary in summaries)])
        print(
            f"{'ID':<{id_width}}  {'Difficulty':<{difficulty_width}}  "
            f"{'Nodes':>5}  {'Edges':>5}  Name"
        )
        for summary in summaries:
            print(
                f"{summary.id:<{id_width}}  {summary.difficulty:<{difficulty_width}}  "
                f"{summary.node_count:>5}  {summary.edge_count:>5}  {summary.name}"
            )
            if args.validate:
                validation = validations[summary.id]
                print(
                    f"  valid={validation.valid}  errors={len(validation.errors)}  "
                    f"warnings={len(validation.warnings)}"
                )
                for error in validation.errors:
                    print(f"  Error: {error}")
                for warning in validation.warnings:
                    print(f"  Warning: {warning}")

    return 1 if any(not validation.valid for validation in validations.values()) else 0


def cmd_graph(args: argparse.Namespace) -> int:
    """Validate a workflow graph or simulate it after validation succeeds."""
    from dataclasses import asdict

    from .graph_engine import simulate_graph
    from .graph_schema import GraphValidationResult, validate_graph
    from .presets import load_preset

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")

    try:
        graph = load_preset(args.graph)
    except (OSError, ValueError) as exc:
        graph = None
        validation = GraphValidationResult(
            valid=False, errors=[str(exc)], warnings=[], entry_nodes=[], has_cycles=False
        )
    else:
        validation = validate_graph(graph)

    if args.graph_command == "validate" or graph is None or not validation.valid:
        if args.json:
            print(json.dumps(asdict(validation), indent=2))
        else:
            print(f"Valid: {validation.valid}")
            print(f"Entry nodes: {', '.join(validation.entry_nodes) or '-'}")
            print(f"Has cycles: {validation.has_cycles}")
            for error in validation.errors:
                print(f"Error: {error}")
            for warning in validation.warnings:
                print(f"Warning: {warning}")
        return 0 if validation.valid else 1

    result = simulate_graph(graph, args.scenario)
    if args.json:
        print(
            json.dumps(
                {
                    "status": result.status,
                    "visited_nodes": result.visited_nodes,
                    "trace": [event.to_dict() for event in result.trace],
                },
                indent=2,
            )
        )
    else:
        for event in result.trace:
            line = (
                f"[{event.seq}] {event.kind} {event.node_id or '-'} "
                f"{event.edge_id or '-'} {event.outcome or '-'} {event.message}"
            )
            print(line.replace("\r", "\\r").replace("\n", "\\n").rstrip())
    return 0 if result.status == "completed" else 1


def cmd_ui(args: argparse.Namespace) -> int:
    """Serve the local canvas and open it in the default browser."""
    from .web_server import VibeBatonWebServer

    server = VibeBatonWebServer(Path(args.repo), host=args.host, port=args.port)
    try:
        print(f"Listening on {server.url}", flush=True)
        if not args.no_open:
            webbrowser.open(server.url)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
    return 0


def cmd_sandbox(args: argparse.Namespace) -> int:
    """Write Docker Compose and Dev Container sandbox scaffolding into a repository."""
    from .sandbox import init_sandbox_files

    repo = Path(args.repo).resolve()
    try:
        written = init_sandbox_files(repo, force=args.force)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2

    if not written:
        print(f"[skip] Sandbox files already exist in {repo} (use --force to overwrite)")
        return 0

    for path in written:
        print(f"[ok] Created sandbox file: {path}")
    return 0


_NOTIFY_TEST_DEFAULT_MESSAGE = "This is a test notification from VibeBaton."
_NOTIFY_CHANNEL_LABELS = {
    "webhook": "webhook",
    "desktop_toast": "toast",
    "terminal_bell": "bell",
}
# Only explicitly enabled channels can fail the command. Default toast/bell
# failures stay visible in their FAIL rows but do not change the exit code.
_FATAL_NOTIFY_CHANNELS = frozenset({"webhook"})
_WEBHOOK_URL_RE = re.compile(r"https?://[^\s]+", re.IGNORECASE)


def _masked_detail(detail: str) -> str:
    """Keep channel details free of webhook URL paths and query strings."""
    return _WEBHOOK_URL_RE.sub(lambda match: mask_webhook_url(match.group(0)), detail)


def run_notify_test(args: argparse.Namespace, notifier: AttentionNotifier | None = None) -> int:
    """Send a test attention event and print one row per notification channel."""
    if args.webhook_url is not None and mask_webhook_url(args.webhook_url) == "***":
        print("Error: --webhook-url must be a valid HTTP(S) URL.", file=sys.stderr)
        return 1

    repo = Path(args.repo).resolve()
    try:
        cfg_path = find_config_path(repo, explicit=Path(args.config) if args.config else None)
        settings = HotReloadConfig(cfg_path).current.notifications
    except FileNotFoundError:
        settings = parse_config_dict({}).notifications

    if args.webhook_url is not None:
        settings = replace(settings, webhook_url=args.webhook_url)

    event = AttentionEvent(
        run_id="notify-test",
        category="test",
        severity="info",
        title="VibeBaton notification test",
        message=args.message or _NOTIFY_TEST_DEFAULT_MESSAGE,
        action_hint="No action required",
    )

    notifier = (
        notifier
        if notifier is not None
        else AttentionNotifier(credentials_path=default_credentials_path())
    )
    result = notifier.notify(event, settings)

    channels = list(result.channels)
    if args.webhook_url is not None and not any(
        channel["channel"] == "webhook" for channel in channels
    ):
        reason = result.skipped_reason or "not attempted"
        if not reason.startswith("skipped:"):
            reason = f"skipped: {reason}"
        channels.append({"channel": "webhook", "ok": True, "detail": reason})

    failed = False
    for channel in channels:
        label = _NOTIFY_CHANNEL_LABELS.get(channel["channel"], channel["channel"])
        detail = _masked_detail(channel["detail"])
        if not channel["ok"]:
            status = "FAIL"
            failed = failed or channel["channel"] in _FATAL_NOTIFY_CHANNELS
        elif detail.startswith("skipped:"):
            status = "SKIP"
        else:
            status = "OK"
        print(f"{status:<4} {label}  {detail}")

    return 1 if failed else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="baton",
        description="VibeBaton — Multi-agent coding workflow orchestrator",
    )
    parser.add_argument("--version", action="version", version=f"vibebaton {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="Initialize .baton/ config and starter RFC in a repo")
    p_init.add_argument("--repo", default=".", help="Target repository path")
    p_init.add_argument("--force", action="store_true", help="Overwrite existing config")
    p_init.set_defaults(func=cmd_init)

    p_doc = sub.add_parser("doctor", help="Check Git, Python, local CLIs, and optional live role smoke test")
    p_doc.add_argument("--repo", default=".")
    p_doc.add_argument("--config", default=None)
    p_doc.add_argument("--role", default=None, help="Run a live 5s smoke test on a specific logical role")
    p_doc.set_defaults(func=cmd_doctor)

    p_run = sub.add_parser("run", help="Start a multi-agent orchestration run")
    p_run.add_argument("--repo", default=".")
    p_run.add_argument("--config", default=None)
    p_run.add_argument("--rfc", required=True, help="Path to Master RFC markdown file")
    p_run.add_argument("--plan", default=None, help="Optional pre-generated 01_PLAN.dag.json")
    p_run.add_argument("--mode", choices=["interactive", "overnight"], default="overnight")
    p_run.add_argument("--override", action="append", help="Override role model: role=model or role=provider:model")
    p_run.add_argument("--detach", action="store_true", help="Run asynchronously in a detached background daemon")
    p_run.set_defaults(func=cmd_run)

    p_daemon = sub.add_parser("daemon", help="Internal detached background daemon worker")
    p_daemon.add_argument("--repo", required=True)
    p_daemon.add_argument("--config", default=None)
    p_daemon.add_argument("--run-id", required=True)
    p_daemon.set_defaults(func=cmd_daemon)

    p_status = sub.add_parser("status", help="Show status of latest or specified run")
    p_status.add_argument("--repo", default=".")
    p_status.add_argument("--config", default=None)
    p_status.add_argument("--run-id", default=None)
    p_status.add_argument("--json", action="store_true")
    p_status.set_defaults(func=cmd_status)

    p_res = sub.add_parser("resolve", help="Approve or reject a WAITING_HUMAN run")
    p_res.add_argument("--repo", default=".")
    p_res.add_argument("--config", default=None)
    p_res.add_argument("--run-id", required=True)
    p_res.add_argument("--decision", choices=["approve", "reject"], required=True)
    p_res.add_argument("--note", default="")
    p_res.add_argument("--resume", action="store_true", help="Automatically spawn daemon on approve")
    p_res.set_defaults(func=cmd_resolve)

    p_rep = sub.add_parser("report", help="Generate Build-in-Public Markdown battle report")
    p_rep.add_argument("--repo", default=".")
    p_rep.add_argument("--config", default=None)
    p_rep.add_argument("--run-id", default=None)
    p_rep.add_argument("--out", default=None, help="Optional output markdown path")
    p_rep.set_defaults(func=cmd_report)

    p_mcp = sub.add_parser("mcp", help="Run zero-dependency MCP stdio server for Antigravity")
    p_mcp.add_argument("--repo", default=None)
    p_mcp.add_argument("--config", default=None)
    p_mcp.set_defaults(func=cmd_mcp)

    p_seed = sub.add_parser("promote-seed", help="Export immutable bootstrap runner snapshot for safe self-hosting")
    p_seed.add_argument("--dest", required=True, help="Destination directory for immutable runner copy")
    p_seed.set_defaults(func=cmd_promote_seed)

    p_presets = sub.add_parser("presets", help="List workflow presets")
    p_presets.add_argument("--validate", action="store_true", help="Validate all presets")
    p_presets.add_argument("--json", action="store_true", help="Output JSON")
    p_presets.set_defaults(func=cmd_presets)

    from .graph_engine import SCENARIOS

    p_graph = sub.add_parser("graph", help="Validate or simulate a workflow graph")
    graph_sub = p_graph.add_subparsers(dest="graph_command", required=True)

    p_validate = graph_sub.add_parser("validate", help="Validate a workflow graph")
    p_validate.add_argument("graph", help="Preset ID or path to a .baton.json file")
    p_validate.add_argument("--json", action="store_true", help="Output JSON")
    p_validate.set_defaults(func=cmd_graph)

    p_simulate = graph_sub.add_parser("simulate", help="Simulate a workflow graph")
    p_simulate.add_argument("graph", help="Preset ID or path to a .baton.json file")
    p_simulate.add_argument("--scenario", choices=SCENARIOS, default="happy_path")
    p_simulate.add_argument("--json", action="store_true", help="Output JSON")
    p_simulate.set_defaults(func=cmd_graph)

    p_ui = sub.add_parser("ui", help="Serve the local workflow canvas")
    p_ui.add_argument("--repo", default=".")
    p_ui.add_argument("--host", default="127.0.0.1")
    p_ui.add_argument("--port", type=int, default=7860)
    p_ui.add_argument("--no-open", action="store_true", help="Skip opening the default browser")
    p_ui.set_defaults(func=cmd_ui)

    p_sandbox = sub.add_parser("sandbox", help="Generate sandbox scaffolding for isolated runs")
    sandbox_sub = p_sandbox.add_subparsers(dest="sandbox_command", required=True)

    p_sandbox_init = sandbox_sub.add_parser(
        "init", help="Write Docker Compose and Dev Container templates"
    )
    p_sandbox_init.add_argument("--repo", default=".", help="Target repository path")
    p_sandbox_init.add_argument(
        "--force", action="store_true", help="Overwrite existing sandbox files"
    )
    p_sandbox_init.set_defaults(func=cmd_sandbox)

    # No help= summary: the top-level command listing is a tested CLI contract.
    p_notify = sub.add_parser("notify-test")
    p_notify.add_argument("--repo", default=".", help="Target repository path")
    p_notify.add_argument("--config", default=None, help="Explicit configuration file path")
    p_notify.add_argument(
        "--webhook-url", default=None, help="Test this webhook URL instead of the configured one"
    )
    p_notify.add_argument("--message", default=None, help="Message body for the test notification")
    p_notify.set_defaults(func=run_notify_test)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
