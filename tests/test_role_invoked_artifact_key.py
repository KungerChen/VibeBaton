"""Every `role_invoked` event names the artifact key of its prompt and output files.

A handoff shown in the Studio has to point at what was handed over. The engine writes each call's
prompt to `.baton/runs/<run_id>/prompts/<artifact_key>.md`; the event carries the same key.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from tests.lineage_fixtures import LineageFixture
from vibebaton import engine as engine_module
from vibebaton.cli_runner import CLIResult
from vibebaton.config import HotReloadConfig
from vibebaton.db import StateStore
from vibebaton.engine import OrchestrationEngine
from vibebaton.schemas import RunStatus

RFC = (
    "# Add a greeting\n\n"
    "## Goals\n\nAdd greeting.txt with one friendly line.\n\n"
    "## Verification & Acceptance Criteria\n\n"
    "1. greeting.txt is committed.\n\n"
    "```bash\ngit ls-files --error-unmatch greeting.txt\n```\n"
)
ROLES = ("tactical_planner", "critical_executor", "bulk_worker", "micro_orchestrator", "milestone_reviewer",
         "brainstorm_and_final_gate")


class RoleInvokedArtifactKeyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.fixture = LineageFixture()
        self.addCleanup(self.fixture.cleanup)
        self.repo = self.fixture.repo
        baton = self.repo / ".baton"
        baton.mkdir()
        self.rfc = baton / "00_RFC.md"
        self.rfc.write_text(RFC, encoding="utf-8")
        config = self.fixture.root / "config.json"
        config.write_text(json.dumps({
            "daemon": {"base_branch": "main", "dev_branch": "dev", "prevent_sleep_windows": False},
            "notifications": {"enabled": False}, "pricing": {"auto_sync": False},
            "policies": {"auto_resolve_merge_conflicts": False},
            "providers": {"fake": {"command": [sys.executable, "-c", "pass"]}},
            "roles": {role: {"provider": "fake", "model": "fake-model"} for role in ROLES},
        }), encoding="utf-8")
        self.store = StateStore(baton / "state.sqlite")
        self.engine = OrchestrationEngine(self.repo, HotReloadConfig(config), self.store)
        self.enterContext(patch("vibebaton.engine.pricing.trigger_background_pricing_sync"))
        real_cli = engine_module.run_provider_cli

        async def cli(provider: object, **kwargs: object) -> CLIResult:
            # The real runner writes the prompt file and runs the no-op command; only the model's
            # answer is made up here.
            result = await real_cli(provider, **kwargs)
            role = kwargs["extra_env"]["VIBEBATON_ROLE"]
            text = json.dumps({"verdict": "PASS", "summary": "OK"})
            if role == "critical_executor":
                text = "done"
                if "_fix_" in Path(str(kwargs["prompt_file"])).stem:
                    (Path(str(kwargs["workdir"])) / "greeting.txt").write_text("Hello!\n", encoding="utf-8")
            return CLIResult(status="ok", exit_code=0, stdout=text, stderr="", duration_sec=result.duration_sec,
                             command=result.command)

        self.enterContext(patch("vibebaton.engine.run_provider_cli", side_effect=cli))

    async def test_each_role_invoked_event_points_at_its_prompt_file(self) -> None:
        run_id = self.engine.create_run(self.rfc, mode="overnight")
        lineup = {"roles": {}, "model_overrides": {}, "size": "small"}
        self.store.log_event(run_id, "guided_launch_selection", payload={"lineup": lineup, "preset": None})
        # The first build misses the file, so the gate fails once and the fix loop adds a third call.
        status = await self.engine.execute_run(run_id)
        self.assertEqual(status, RunStatus.READY_FOR_FINAL_GATE, self.store.get_run(run_id)["summary"])

        invoked = [event for event in self.store.get_events(run_id, limit=-1) if event["kind"] == "role_invoked"]
        payloads = [json.loads(event["payload_json"]) for event in invoked]
        self.assertEqual(payloads, [
            {"artifact_key": "T1_exec_1"},
            {"artifact_key": "milestone_M1_fix_r1"},
            {"artifact_key": "milestone_M1_review_r1"},
        ])
        prompts = self.repo / ".baton" / "runs" / run_id / "prompts"
        for payload in payloads:
            self.assertTrue((prompts / f"{payload['artifact_key']}.md").is_file(), payload)
        # The event row id is the stable handle a handoff card can cite.
        ids = [event["id"] for event in invoked]
        self.assertEqual(ids, sorted(set(ids)))


if __name__ == "__main__":
    unittest.main()
