"""Golden examples for resumable, revision-aware brainstorm turns; no network is used."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from vibebaton import brainstorm
from vibebaton.brainstorm import brainstorm_turn
from vibebaton.config import parse_config_dict
from vibebaton.model_catalog import BUNDLED_MODELS
from vibebaton.workflow_recommend import ProviderReadiness, ReadinessSnapshot


PRIOR_RFC = (
    "# Health endpoint\n\n## Goals\n\nExpose health to operators.\n\n"
    "Audience: operations team\n\n- Add GET /health.\n\n"
    "## Constraints\n\n- Keep existing interfaces.\n\n"
    "## Non-Goals\n\n- No authentication changes.\n\n"
    "## Architecture & Deliverables\n\n- `src/server.py`\n\n"
    "## Verification & Acceptance Criteria\n\n1. Health succeeds.\n\n"
    "```bash\npython -m unittest\n```\n\n"
)
REVISED_RFC = PRIOR_RFC.replace("GET /health", "GET /health with version")
REQUESTED_CHANGES = "Include the app version in the health response."
FAILURE_CONTEXT = "The previous run stopped after the API contract check failed."
L0_ROLE = "brainstorm_and_final_gate"


def live_reply(rfc: str = REVISED_RFC, guide: dict[str, Any] | None = None) -> str:
    guide_block = "" if guide is None else f"\n```guide\n{json.dumps(guide)}\n```\n"
    return f"The blueprint is updated.{guide_block}\n````rfc\n{rfc}````\n"


class FakeModelRunner:
    """A model runner that records the exact prompt and identifies its responding target."""

    def __init__(self, provider: str, model: str, rfc: str = REVISED_RFC) -> None:
        self.provider = provider
        self.model = model
        self.rfc = rfc
        self.prompts: list[str] = []

    def __call__(self, prompt: str) -> tuple[str, str, str]:
        self.prompts.append(prompt)
        return self.provider, self.model, live_reply(self.rfc)


class BrainstormHardeningTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name)
        env = patch.dict(os.environ, {name: "" for name in brainstorm.OFFLINE_ENV_VARS})
        env.start()
        self.addCleanup(env.stop)
        self.messages: list[brainstorm.ChatMessage] = [{"role": "user", "content": REQUESTED_CHANGES}]

    def test_switching_models_keeps_exact_latest_draft_and_reports_both_models(self) -> None:
        first_runner = FakeModelRunner("claude_sub", "claude-opus-5-5@medium", PRIOR_RFC)
        first = brainstorm_turn(
            self.repo, self.messages, dispatch=first_runner,
            model_overrides={L0_ROLE: "claude_sub:claude-opus-5-5@medium"},
        )
        latest = first["rfc_markdown"] + "\nDraft detail with `nested` formatting.\n\n"
        second_runner = FakeModelRunner("codex_sub", "gpt-6.2-astra@xhigh")
        second = brainstorm_turn(
            self.repo, self.messages, dispatch=second_runner, latest_rfc_draft=latest,
            has_online_draft=True, model_overrides={L0_ROLE: "codex_sub:gpt-6.2-astra@xhigh"},
        )

        self.assertIn(latest, second_runner.prompts[0])
        self.assertEqual(first["requested_model"], "claude_sub:claude-opus-5-5@medium")
        self.assertEqual(first["responding_model"], "claude-opus-5-5@medium")
        self.assertEqual(second["requested_model"], "codex_sub:gpt-6.2-astra@xhigh")
        self.assertEqual(second["provider_used"], "codex_sub")
        self.assertEqual(second["responding_model"], "gpt-6.2-astra@xhigh")
        self.assertFalse(second["offline"])
        self.assertEqual(second["rfc_markdown"], REVISED_RFC.rstrip() + "\n")

    def test_legacy_provider_only_runner_does_not_invent_a_model(self) -> None:
        result = brainstorm_turn(
            self.repo, self.messages, dispatch=lambda prompt: ("fallback_provider", live_reply()),
            model_overrides={L0_ROLE: "requested_provider:requested_model"},
        )
        self.assertEqual(result["provider_used"], "fallback_provider")
        self.assertIsNone(result["responding_model"])
        self.assertEqual(result["requested_model"], "requested_provider:requested_model")

    def test_configured_l0_model_reports_its_optional_effort(self) -> None:
        for model in ("gpt-6.2-astra@xhigh", "gpt-6.2-astra"):
            with self.subTest(model=model):
                config = parse_config_dict({
                    "providers": {"codex_sub": {"command": ["codex"]}},
                    "roles": {L0_ROLE: {"provider": "codex_sub", "model": model}},
                })
                result = brainstorm_turn(
                    self.repo, self.messages, cfg=config,
                    dispatch=FakeModelRunner("codex_sub", model),
                )
                self.assertEqual(result["requested_model"], f"codex_sub:{model}")
                self.assertEqual(result["responding_model"], model)

    def test_failed_live_turn_preserves_an_online_draft_and_is_retryable(self) -> None:
        latest = PRIOR_RFC + "\nUnconfirmed owner edit.\n\n"

        def fail(_prompt: str) -> tuple[str, str, str]:
            raise RuntimeError("model unavailable")

        for dispatcher in (fail, lambda prompt: ("codex_sub", "gpt-6.2-astra", "missing RFC")):
            with self.subTest(dispatcher=dispatcher):
                result = brainstorm_turn(
                    self.repo, self.messages, dispatch=dispatcher, latest_rfc_draft=latest,
                    has_online_draft=True, model_overrides={L0_ROLE: "codex_sub:gpt-6.2-astra@xhigh"},
                )
                self.assertEqual(result["rfc_markdown"], latest)
                self.assertTrue(result["retryable"])
                self.assertTrue(result["error"])
                self.assertFalse(result["offline"])
                self.assertIsNone(result["provider_used"])
                self.assertIsNone(result["responding_model"])
                self.assertEqual(result["requested_model"], "codex_sub:gpt-6.2-astra@xhigh")
                self.assertEqual(result["blueprint"], brainstorm._blueprint(latest))
                self.assertNotIn("Implementation areas are chosen during planning", result["rfc_markdown"])

    def test_online_draft_is_protected_when_no_provider_or_offline_is_forced(self) -> None:
        for offline in (False, True):
            with self.subTest(offline=offline), patch.dict(
                os.environ, {brainstorm.OFFLINE_ENV_VARS[0]: "1" if offline else ""},
            ):
                runner = FakeModelRunner("codex_sub", "model") if offline else None
                result = brainstorm_turn(
                    self.repo, self.messages, dispatch=runner, latest_rfc_draft=PRIOR_RFC, has_online_draft=True,
                )
                self.assertEqual(result["rfc_markdown"], PRIOR_RFC)
                self.assertTrue(result["retryable"])
                self.assertTrue(result["error"])
                self.assertFalse(result["offline"])
                if runner:
                    self.assertEqual(runner.prompts, [])

    def test_online_draft_flag_requires_the_draft_it_protects(self) -> None:
        with self.assertRaises(ValueError):
            brainstorm_turn(self.repo, self.messages, has_online_draft=True)

    def test_revision_requires_prior_rfc_and_requested_changes(self) -> None:
        for revision in ({}, {"prior_rfc": PRIOR_RFC, "requested_changes": " "},
                         {"prior_rfc": PRIOR_RFC, "requested_changes": REQUESTED_CHANGES, "failure_context": 3}):
            with self.subTest(revision=revision), self.assertRaises(ValueError):
                brainstorm_turn(self.repo, self.messages, revision=revision)  # type: ignore[arg-type]

    def test_revision_context_premarks_checklist_and_is_supplied_verbatim(self) -> None:
        runner = FakeModelRunner("codex_sub", "gpt-6.2-astra@xhigh")
        revision: brainstorm.RevisionContext = {
            "prior_rfc": PRIOR_RFC,
            "requested_changes": REQUESTED_CHANGES,
            "failure_context": FAILURE_CONTEXT,
        }
        result = brainstorm_turn(self.repo, self.messages, dispatch=runner, revision=revision)
        prompt = runner.prompts[0]
        self.assertIn(PRIOR_RFC, prompt)
        self.assertIn(REQUESTED_CHANGES, prompt)
        self.assertIn(FAILURE_CONTEXT, prompt)
        self.assertEqual([item["id"] for item in result["guide"]["checklist"]], list(brainstorm.CHECKLIST_IDS))
        self.assertTrue(all(item["status"] == "clear" and item["value"] for item in result["guide"]["checklist"]))
        for item in result["guide"]["checklist"]:
            self.assertIn(json.dumps(item, ensure_ascii=False), prompt)
        self.assertEqual(result["guide"]["question"], "")
        self.assertEqual(len(runner.prompts), 1)

    def test_revision_does_not_reopen_premarked_items_when_live_guide_is_incomplete(self) -> None:
        partial = {"question": "", "options": [], "checklist": [
            {"id": "what", "status": "clear", "value": "Revised endpoint"},
            {"id": "scope", "status": "open", "value": ""},
        ], "size": "small"}
        result = brainstorm_turn(
            self.repo, self.messages,
            dispatch=lambda prompt: ("codex_sub", "gpt-6.2-astra", live_reply(guide=partial)),
            revision={"prior_rfc": PRIOR_RFC, "requested_changes": REQUESTED_CHANGES},
        )
        guide = result["guide"]
        self.assertEqual(guide["size"], "small")
        self.assertEqual(guide["checklist"][0]["value"], "Revised endpoint")
        self.assertTrue(all(item["status"] == "clear" and item["value"] for item in guide["checklist"]))

    def test_revision_preserves_new_assumptions_returned_by_the_model(self) -> None:
        guide = {"question": "", "options": [], "checklist": [
            {"id": "limits", "status": "assumed", "value": "No new dependencies"},
        ]}
        result = brainstorm_turn(
            self.repo, self.messages,
            dispatch=lambda prompt: ("codex_sub", "gpt-6.2-astra", live_reply(guide=guide)),
            revision={"prior_rfc": PRIOR_RFC, "requested_changes": REQUESTED_CHANGES},
        )
        limits = next(item for item in result["guide"]["checklist"] if item["id"] == "limits")
        self.assertEqual(limits, {"id": "limits", "status": "assumed", "value": "No new dependencies"})

    def test_revision_preserves_prior_blueprint_when_no_live_response_exists(self) -> None:
        for latest in ("", REVISED_RFC):
            with self.subTest(latest=bool(latest)):
                result = brainstorm_turn(
                    self.repo, self.messages, latest_rfc_draft=latest,
                    revision={"prior_rfc": PRIOR_RFC, "requested_changes": REQUESTED_CHANGES},
                )
                self.assertEqual(result["rfc_markdown"], latest or PRIOR_RFC)
                self.assertTrue(result["retryable"])
                self.assertTrue(result["error"])
                self.assertTrue(all(item["status"] == "clear" for item in result["guide"]["checklist"]))

    def test_without_online_draft_fallback_still_uses_offline_flow(self) -> None:
        baseline = brainstorm_turn(self.repo, self.messages)

        def fail(_prompt: str) -> tuple[str, str, str]:
            raise RuntimeError("down")

        result = brainstorm_turn(self.repo, self.messages, dispatch=fail)
        self.assertTrue(result["offline"])
        self.assertEqual(result["error"], "down")
        self.assertEqual({**result, "error": None}, baseline)
        self.assertFalse(result["blueprint"]["ready_to_launch"])
        self.assertNotIn("start building", result["reply"])

    def test_provider_dispatch_reports_the_target_that_succeeds_after_fallback(self) -> None:
        cfg = parse_config_dict({
            "providers": {
                "claude_sub": {"command": ["claude", "--model", "{model_name}"]},
                "codex_sub": {"command": ["codex", "--model", "{model_name}"]},
            },
            "roles": {L0_ROLE: {
                "provider": "claude_sub", "model": "claude-opus-5-5@medium",
                "fallback": [{"provider": "codex_sub", "model": "gpt-6.2-astra@xhigh"}],
            }},
        })
        invoked: list[tuple[str, str]] = []

        def invoke(_cfg: Any, provider: Any, model: str, _prompt: str) -> tuple[str, str]:
            invoked.append((provider.name, model))
            if provider.name == "claude_sub":
                raise RuntimeError("primary unavailable")
            return provider.name, live_reply()

        with patch("vibebaton.credentials.probe_role_or_provider", return_value={"ok": True}), \
                patch.object(brainstorm, "_invoke", side_effect=invoke):
            result = brainstorm_turn(self.repo, self.messages, cfg=cfg)
        self.assertEqual(invoked, [("claude_sub", "claude-opus-5-5@medium"), ("codex_sub", "gpt-6.2-astra@xhigh")])
        self.assertEqual(result["requested_model"], "claude_sub:claude-opus-5-5@medium")
        self.assertEqual(result["provider_used"], "codex_sub")
        self.assertEqual(result["responding_model"], "gpt-6.2-astra@xhigh")
        self.assertIsNone(result["error"])

        with patch("vibebaton.credentials.probe_role_or_provider", return_value={"ok": True}), \
                patch.object(brainstorm, "_invoke", side_effect=RuntimeError("all targets failed")):
            failed = brainstorm_turn(self.repo, self.messages, cfg=cfg, latest_rfc_draft=PRIOR_RFC,
                                     has_online_draft=True)
        self.assertEqual(failed["rfc_markdown"], PRIOR_RFC)
        self.assertEqual(failed["error"], "all targets failed")
        self.assertTrue(failed["retryable"])

    def test_auto_select_uses_ranked_ready_providers_and_known_models(self) -> None:
        def provider(name: str, ready: bool = True, credential: bool = True) -> ProviderReadiness:
            return ProviderReadiness(name, "cli", ready, credential)

        snapshot = ReadinessSnapshot((provider("codex_sub"), provider("claude_sub"), provider("agy_sub")))
        self.assertEqual(brainstorm.auto_select_l0_model(snapshot), "agy_sub:gemini-4-carbon@medium")
        snapshot = ReadinessSnapshot((provider("agy_sub", credential=False), provider("codex_sub")))
        self.assertEqual(brainstorm.auto_select_l0_model(snapshot), "codex_sub:gpt-6.2-astra@xhigh")
        snapshot = ReadinessSnapshot((provider("unknown"), provider("codex_sub")))
        self.assertEqual(brainstorm.auto_select_l0_model(snapshot), "codex_sub:gpt-6.2-astra@xhigh")
        self.assertIsNone(brainstorm.auto_select_l0_model(ReadinessSnapshot((provider("unknown"),))))
        self.assertIsNone(brainstorm.auto_select_l0_model(ReadinessSnapshot((provider("codex_sub", ready=False),))))
        # A current catalog with the top recommendation unavailable must use the next available flagship.
        models = [model for model in BUNDLED_MODELS if model["id"] != "gemini-4-carbon"]
        snapshot = ReadinessSnapshot((provider("agy_sub"), provider("codex_sub")))
        self.assertEqual(brainstorm.auto_select_l0_model(snapshot, models=models), "codex_sub:gpt-6.2-astra@xhigh")

    def test_live_turn_asks_for_verification_command_when_checklist_settled_without_command(self) -> None:
        rfc_without_cmd = (
            "# Budget Tracker\n\n## Goals\n\nPersonal browser budget tracker.\n\n- Add and remove entries.\n\n"
            "## Constraints\n\n- Keep dependencies minimal.\n\n"
            "## Non-Goals\n\n- No cloud sync.\n\n"
            "## Architecture & Deliverables\n\n- `index.html`\n\n"
            "## Verification & Acceptance Criteria\n\n1. Open in browser and check manually.\n"
        )
        clear_guide = {
            "question": "",
            "options": [],
            "checklist": [
                {"id": item_id, "status": "clear", "value": "settled"}
                for item_id in brainstorm.CHECKLIST_IDS
            ],
            "size": "small",
        }
        for locale, messages in (
            ("zh", [{"role": "user", "content": "做一个简易记账工具"}]),
            ("en", [{"role": "user", "content": "Make a simple budget tracker"}]),
        ):
            with self.subTest(locale=locale):
                result = brainstorm_turn(
                    self.repo,
                    messages,
                    locale=locale,
                    dispatch=lambda _prompt: ("claude_sub", "claude-opus-5-5@medium", live_reply(rfc_without_cmd, clear_guide)),
                )
                expected_q = brainstorm._CHECK_QUESTION[locale]
                self.assertFalse(result["blueprint"]["ready_to_launch"])
                self.assertEqual(result["guide"]["question"], expected_q)
                self.assertEqual(result["guide"]["options"], brainstorm._check_command_options(self.repo))
                self.assertTrue(2 <= len(result["guide"]["options"]) <= 4)
                self.assertIn(expected_q, result["reply"])


if __name__ == "__main__":
    unittest.main()
