"""Full 4-tier E2E pipeline & MCP JSON-RPC test using real Git worktrees + deterministic Mock CLIs."""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from vibebaton.config import HotReloadConfig, build_model_catalog
from vibebaton.db import StateStore
from vibebaton.engine import OrchestrationEngine
from vibebaton.mcp_server import VibeBatonMCPServer
from vibebaton.report import generate_battle_report
from vibebaton.schemas import RunStatus

# Mock agent script executed as a real subprocess CLI for all 3 providers!
_MOCK_AGENT_SCRIPT = r'''
import json
import os
import sys
from pathlib import Path

role = os.environ.get("VIBEBATON_ROLE", "")
task_id = os.environ.get("VIBEBATON_TASK_ID", "")
milestone_id = os.environ.get("VIBEBATON_MILESTONE_ID", "")
state_dir = Path(os.environ["MOCK_STATE_DIR"])
state_dir.mkdir(parents=True, exist_ok=True)
_prompt = sys.stdin.read()

def bump(key: str) -> int:
    f = state_dir / f"{key}.count"
    n = int(f.read_text()) + 1 if f.exists() else 1
    f.write_text(str(n))
    return n

# 1. Tactical Planner (Claude Fable) — simulate 429 rate limit on 1st call, succeed on 2nd
if role == "tactical_planner":
    n = bump("planner")
    if n == 1:
        sys.stderr.write("Error 429: usage limit reached, try again in 1 sec\n")
        sys.exit(1)
    plan = {
        "rfc_version": "v1.0",
        "complexity_tier": "M",
        "summary": "Build calculator contract and multiply routine",
        "milestones": [
            {
                "id": "M1",
                "title": "Math Core",
                "reviewer_role": "milestone_reviewer",
                "gate_commands": [f'"{sys.executable}" -m unittest discover -s tests -q'],
                "tasks": [
                    {
                        "id": "T-101",
                        "title": "Author add() contract and golden example",
                        "tier": "critical",
                        "assignee_role": "critical_executor",
                        "reviewer_role": None,
                        "depends_on": [],
                        "allowed_paths": ["src/math_ops.py", "tests/test_add.py"],
                        "acceptance_criteria": ["Export add(a, b) with passing unit test"],
                        "verify_cmd": f'"{sys.executable}" -m unittest tests/test_add.py'
                    },
                    {
                        "id": "T-102",
                        "title": "Implement multiply() following golden example",
                        "tier": "routine",
                        "assignee_role": "bulk_worker",
                        "reviewer_role": "micro_orchestrator",
                        "depends_on": ["T-101"],
                        "allowed_paths": ["src/multiply.py", "tests/test_multiply.py"],
                        "golden_example": "src/math_ops.py",
                        "acceptance_criteria": ["Export multiply(a, b) with passing unit test"],
                        "verify_cmd": f'"{sys.executable}" -m unittest tests/test_multiply.py',
                        "max_self_heal": 2,
                        "max_review_rejects": 1,
                        "escalate_role": "critical_executor"
                    }
                ]
            }
        ]
    }
    print(json.dumps(plan))
    sys.exit(0)

# 2. Critical Specialist (Codex Sol)
if role == "critical_executor":
    if task_id == "T-101":
        Path("src").mkdir(exist_ok=True)
        Path("tests").mkdir(exist_ok=True)
        Path("src/math_ops.py").write_text("def add(a: int, b: int) -> int:\n    return a + b\n", encoding="utf-8")
        Path("tests/test_add.py").write_text(
            "import unittest\nfrom src.math_ops import add\n"
            "class T(unittest.TestCase):\n    def test_add(self): self.assertEqual(add(2, 3), 5)\n",
            encoding="utf-8",
        )
        print("Created contract & golden example.")
        sys.exit(0)
    if task_id == "T-102":
        # Escalated from DSH! Fix cleanly with proper docstring/types.
        Path("src/multiply.py").write_text(
            "def multiply(a: int, b: int) -> int:\n    \"\"\"Multiply two ints.\"\"\"\n    return a * b\n",
            encoding="utf-8",
        )
        Path("tests/test_multiply.py").write_text(
            "import unittest\nfrom src.multiply import multiply\n"
            "class T(unittest.TestCase):\n    def test_mul(self): self.assertEqual(multiply(3, 4), 12)\n",
            encoding="utf-8",
        )
        print("Specialist completed escalated task cleanly.")
        sys.exit(0)

# 3. Bulk Worker (DSH / OpenCode)
if role == "bulk_worker" and task_id == "T-102":
    n = bump("dsh_t102")
    Path("src").mkdir(exist_ok=True)
    Path("tests").mkdir(exist_ok=True)
    if n == 1:
        # Attempt 1: Violate path whitelist by touching README.md
        Path("README.md").write_text("OOPS FORBIDDEN EDIT\n", encoding="utf-8")
        Path("src/multiply.py").write_text("def multiply(a, b): return a * b\n", encoding="utf-8")
        sys.exit(0)
    if n == 2:
        # Attempt 2: Buggy math so mechanical gate catches it!
        Path("src/multiply.py").write_text("def multiply(a, b): return a + b\n", encoding="utf-8")
        Path("tests/test_multiply.py").write_text(
            "import unittest\nfrom src.multiply import multiply\n"
            "class T(unittest.TestCase):\n    def test_mul(self): self.assertEqual(multiply(3, 4), 12)\n",
            encoding="utf-8",
        )
        sys.exit(0)
    # Attempt 3+: Passes mechanical gate, but reviewer will reject to test escalation circuit breaker
    Path("src/multiply.py").write_text("def multiply(a, b): return a * b\n", encoding="utf-8")
    Path("tests/test_multiply.py").write_text(
        "import unittest\nfrom src.multiply import multiply\n"
        "class T(unittest.TestCase):\n    def test_mul(self): self.assertEqual(multiply(3, 4), 12)\n",
        encoding="utf-8",
    )
    sys.exit(0)

# 4. Micro-Orchestrator Reviewer (Codex Astra)
if role == "micro_orchestrator":
    verdict = {
        "target_id": task_id,
        "reviewer": "codex_sub:6.2-astra-xhigh",
        "verdict": "MINOR_FIX",
        "summary": "Missing type annotations compared to Golden Example",
        "blocking_issues": [
            {"file": "src/multiply.py", "line": 1, "category": "contract_violation", "message": "Add int type hints"}
        ],
    }
    print(json.dumps(verdict))
    sys.exit(0)

# 5. Milestone Reviewer (Claude Opus)
if role == "milestone_reviewer":
    verdict = {
        "target_id": milestone_id,
        "reviewer": "claude_sub:opus-5.5-high",
        "verdict": "PASS",
        "summary": "Milestone meets RFC and all gates passed.",
        "blocking_issues": [],
        "nitpicks": ["Consider adding division in M2"],
    }
    print(json.dumps(verdict))
    sys.exit(0)

sys.stderr.write(f"Unhandled mock call: role={role} task={task_id}\n")
sys.exit(1)
'''


class TestEndToEndPipeline(unittest.TestCase):
    def test_full_4tier_pipeline_with_guardrails_escalation_cooldown_and_mcp(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            repo = tmp_path / "demo_repo"
            repo.mkdir()

            # Initialize clean git repo
            subprocess.run(["git", "init", "-b", "main"], cwd=str(repo), check=True, capture_output=True)
            subprocess.run(["git", "config", "user.email", "ci@vibebaton.local"], cwd=str(repo), check=True)
            subprocess.run(["git", "config", "user.name", "VibeBaton CI"], cwd=str(repo), check=True)
            (repo / "README.md").write_text("# Demo Repo\n", encoding="utf-8")
            (repo / "src").mkdir()
            (repo / "src" / "__init__.py").write_text("", encoding="utf-8")
            (repo / "tests").mkdir()
            (repo / "tests" / "__init__.py").write_text("", encoding="utf-8")
            subprocess.run(["git", "add", "-A"], cwd=str(repo), check=True)
            subprocess.run(["git", "commit", "-m", "initial commit"], cwd=str(repo), check=True, capture_output=True)

            # Write mock CLI script & RFC
            mock_script = tmp_path / "mock_agent.py"
            mock_script.write_text(_MOCK_AGENT_SCRIPT, encoding="utf-8")
            mock_state = tmp_path / "mock_state"

            rfc_file = repo / ".baton" / "00_RFC.md"
            rfc_file.parent.mkdir(parents=True, exist_ok=True)
            rfc_file.write_text("# RFC\nBuild add() and multiply() with full unit tests.\n", encoding="utf-8")

            # Write JSON config pointing all 3 providers to our mock CLI
            cfg_path = repo / ".baton" / "config.json"
            py = sys.executable
            common_env = {"MOCK_STATE_DIR": str(mock_state)}
            cfg_dict = {
                "daemon": {
                    "db_path": ".baton/state.sqlite",
                    "worktree_root": ".baton/worktrees",
                    "base_branch": "main",
                    "dev_branch": "dev",
                    "prevent_sleep_windows": False,
                    "default_stall_timeout_sec": 30,
                    "default_hard_timeout_sec": 60,
                },
                "policies": {
                    "machine_gate_before_ai_review": True,
                    "max_self_heal_attempts": 2,
                    "max_review_rejects": 1,
                },
                "providers": {
                    "claude_sub": {
                        "max_concurrency": 1,
                        "cooldown_backoff_sec": [1],
                        "command": [py, str(mock_script)],
                        "prompt_via": "stdin",
                        "env": common_env,
                    },
                    "codex_sub": {
                        "max_concurrency": 1,
                        "cooldown_backoff_sec": [1],
                        "command": [py, str(mock_script)],
                        "prompt_via": "stdin",
                        "env": common_env,
                    },
                    "dsh_opencode": {
                        "max_concurrency": 3,
                        "cooldown_backoff_sec": [1],
                        "command": [py, str(mock_script)],
                        "prompt_via": "stdin",
                        "env": common_env,
                    },
                },
                "roles": {
                    "brainstorm_and_final_gate": {"provider": "host_native", "model": "gemini-4-neon-high"},
                    "tactical_planner": {"provider": "claude_sub", "model": "fable-5.2-high"},
                    "milestone_reviewer": {"provider": "claude_sub", "model": "opus-5.5-high"},
                    "micro_orchestrator": {"provider": "codex_sub", "model": "6.2-astra-xhigh"},
                    "critical_executor": {"provider": "codex_sub", "model": "6.2-sol-max"},
                    "bulk_worker": {"provider": "dsh_opencode", "model": "deepseek-flash-v4.1-max"},
                },
            }
            cfg_path.write_text(json.dumps(cfg_dict, indent=2), encoding="utf-8")

            loader = HotReloadConfig(cfg_path)
            store = StateStore(repo / ".baton" / "state.sqlite")
            run_id = store.create_run(repo_path=repo, rfc_path=rfc_file, mode="overnight")

            engine = OrchestrationEngine(repo_path=repo, config_loader=loader, store=store)
            with patch("vibebaton.engine.build_model_catalog", wraps=build_model_catalog) as build_catalog:
                final_status = asyncio.run(engine.execute_run(run_id))
            self.assertEqual(final_status, RunStatus.READY_FOR_FINAL_GATE)
            build_catalog.assert_called_once_with(loader.current, None)

            # Verify all guardrails actually fired during the run!
            events = store.get_events(run_id, limit=500)
            event_kinds = [e["kind"] for e in events]
            self.assertIn("quota_rate_limited", event_kinds)
            self.assertIn("whitelist_violation", event_kinds)
            self.assertIn("mechanical_gate_caught", event_kinds)
            self.assertIn("task_review_rejected", event_kinds)
            self.assertIn("task_escalated", event_kinds)
            self.assertIn("milestone_passed", event_kinds)

            allocations = [json.loads(e["payload_json"]) for e in events if e["kind"] == "task_allocated"]
            self.assertCountEqual(
                [a["task_id"] for a in allocations],
                [t["id"] for t in store.get_tasks(run_id) for _ in range(t["attempts"])],
            )
            for allocation in allocations:
                self.assertTrue(allocation["provider"] and allocation["model"] and allocation["reason"])
            step_ups = [json.loads(e["payload_json"]) for e in events if e["kind"] == "task_step_up"]
            self.assertTrue(step_ups)
            self.assertEqual(step_ups[0], {
                "task_id": "T-102", "from": "dsh_opencode:deepseek-flash-v4.1-max",
                "to": "claude_sub:fable-5.2-high", "attempt": 5,
            })

            # Verify T-102 was escalated to critical_executor and merged cleanly into dev
            t102 = store.get_task(run_id, "T-102")
            self.assertEqual(t102["status"], "PASSED")
            self.assertEqual(t102["escalated"], 1)
            self.assertEqual(t102["current_role"], "critical_executor")

            mul_src = subprocess.run(
                ["git", "show", "dev:src/multiply.py"],
                cwd=str(repo),
                capture_output=True,
                text=True,
                check=True,
            ).stdout
            self.assertIn("def multiply(a: int, b: int) -> int:", mul_src)

            # Verify Battle Report generation
            report_md = generate_battle_report(store, run_id)
            self.assertIn("Mechanical Gate Catches | **1**", report_md)
            self.assertIn("Path Whitelist Catches | **1**", report_md)
            self.assertIn("Circuit-Breaker Escalations | **1**", report_md)
            self.assertIn("Subscription Cooldowns Handled | **1**", report_md)
            self.assertIn("## Smart Allocation Summary", report_md)
            self.assertIn("| `T-101` | `codex_sub` | `6.2-sol-max` |", report_md)
            self.assertIn("`dsh_opencode:deepseek-flash-v4.1-max` → `claude_sub:fable-5.2-high`", report_md)

            # Verify zero-dependency MCP Server JSON-RPC protocol
            mcp = VibeBatonMCPServer(default_repo=repo, explicit_config=cfg_path)
            init_resp = mcp.handle_request({"jsonrpc": "2.0", "id": 1, "method": "initialize"})
            self.assertEqual(init_resp["result"]["serverInfo"]["name"], "vibebaton")

            list_resp = mcp.handle_request({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
            tool_names = [t["name"] for t in list_resp["result"]["tools"]]
            self.assertEqual(len(tool_names), 9)
            self.assertIn("baton_start", tool_names)
            self.assertIn("baton_list_presets", tool_names)
            self.assertIn("baton_validate_graph", tool_names)

            pkg_resp = mcp.handle_request(
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {"name": "baton_final_package", "arguments": {"repo_path": str(repo), "run_id": run_id}},
                }
            )
            self.assertFalse(pkg_resp["result"]["isError"])
            pkg_payload = json.loads(pkg_resp["result"]["content"][0]["text"])
            self.assertEqual(pkg_payload["status"], "READY_FOR_FINAL_GATE")
            self.assertIn("def multiply(a: int, b: int) -> int:", pkg_payload["diff_dev_vs_base"])


if __name__ == "__main__":
    unittest.main()
