"""Invariants that keep every provider + model + effort choice real.

Against the bundled catalog plus a fixed snapshot of what the tools and the feed report, every tier
recommendation, model default, role recommendation, tiered team (normal and lean), shipped preset and
the example config must name a model the provider offers with an effort that provider accepts. Adding a
model or changing a recommendation that breaks this turns these tests red.
"""

from __future__ import annotations

import itertools
import json
import tomllib
import unittest
from pathlib import Path

from vibebaton import model_catalog
from vibebaton.workflow_recommend import ProviderReadiness, _tiered_lineup

from tests.test_workflow_recommend import example_config

ROOT = Path(__file__).resolve().parents[1]
PROVIDERS = ("agy_sub", "gemini_sub", "claude_sub", "codex_sub", "dsh_opencode", "dsh_deepseek",
             "openai_http", "gemini_http")

# What the tools reported on a real host (2026-11-27): `agy models`, `gemini --list-models`, the Codex cache.
CLI_MODELS: model_catalog.CliModels = {
    "agy_sub": {
        "gemini-4-neon": ["low", "medium", "high", "xhigh"],
        "gemini-4-carbon": ["low", "medium", "high"],
        "gemini-4-hydrogen": ["low", "medium", "high", "xhigh"],
        "gemini-pro-orchestrator": [],
        "claude-opus-5-5": ["low", "medium", "high"],
        "claude-sonnet-5-5": ["low", "medium", "high"],
        "gpt-oss-120b": ["medium"],
    },
    "gemini_sub": {"gemini-2.5-pro": [], "gemini-3.5-flash": [], "gemini-3.1-flash-lite": []},
    "codex_sub": {
        "gpt-6.2-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
        "gpt-6.2-astra": ["low", "medium", "high", "xhigh", "max", "ultra"],
        "gpt-6.1-terra": ["low", "medium", "high", "xhigh", "max", "ultra"],
        "gpt-6-luna": ["low", "medium", "high", "xhigh", "max"],
    },
}
CLI_DECLARED = {"claude_sub": ["low", "medium", "high", "xhigh", "max"]}  # `claude --help`
FEED_EFFORTS = {  # feed reasoning flags
    "gpt-4o": [], "gpt-4.1": [],
    "o3": ["low", "medium", "high"],
    "gpt-5": ["minimal", "low", "medium", "high"],
    "deepseek-reasoner": [],
}
# Model strings that cannot be checked on purpose: host_native runs whatever the host offers.
UNCHECKED_PROVIDERS = frozenset({"host_native"})


def fixture_catalog() -> list[model_catalog.ModelCatalogEntry]:
    merged = model_catalog._apply_cli_models(model_catalog._merge_catalog([]), CLI_MODELS)
    return model_catalog.resolve_catalog_efforts(
        model_catalog._rank_catalog(merged), cli_models=CLI_MODELS, cli_declared=CLI_DECLARED,
        feed_efforts=FEED_EFFORTS,
    )


def legal(catalog: list, provider: str, model: str, effort: str) -> str | None:
    """None when legal; otherwise why not."""
    entry = model_catalog.find_catalog_model(provider, model, catalog)
    if entry is None:
        return f"{model} is not offered by {provider}"
    allowed = model_catalog.allowed_efforts(entry, provider)
    if (effort or "") not in (allowed if allowed else [""]):
        return f"{provider}:{model}@{effort} not in {allowed}"
    return None


def specs_in(document: object, path: str = ""):
    if isinstance(document, dict):
        if isinstance(document.get("provider"), str) and isinstance(document.get("model"), str):
            yield path, document["provider"], document["model"]
        for key, value in document.items():
            yield from specs_in(value, f"{path}.{key}")
    elif isinstance(document, list):
        for index, value in enumerate(document):
            yield from specs_in(value, f"{path}[{index}]")


class EffortInvariantTests(unittest.TestCase):
    def setUp(self) -> None:
        self.catalog = fixture_catalog()

    def test_every_tier_recommendation_is_legal_for_each_listed_provider(self) -> None:
        for tier, recs in model_catalog.TIER_RECOMMENDATIONS.items():
            for rec in recs:
                for provider in rec["providers"]:
                    with self.subTest(tier=tier, provider=provider, model=rec["model"]):
                        self.assertIsNone(legal(self.catalog, provider, rec["model"], rec["effort"]))

    def test_every_model_default_is_legal_on_each_provider(self) -> None:
        for entry in self.catalog:
            for provider in entry["providers"]:
                with self.subTest(model=entry["id"], provider=provider):
                    allowed = entry["provider_efforts"][provider]
                    default = entry["provider_defaults"][provider]
                    self.assertIn(default, allowed if allowed else [""])
                    self.assertIn(entry["effort_sources"][provider], ("cli_models", "cli_declared", "feed", "default"))

    def test_role_recommendations_are_legal_for_every_provider_subset(self) -> None:
        for size in range(1, len(PROVIDERS) + 1):
            for subset in itertools.combinations(PROVIDERS, size):
                for role in model_catalog.ROLE_TIERS:
                    pick = model_catalog.recommend_role_assignment(role, subset, self.catalog)
                    if pick is None or not pick["model"]:
                        continue
                    problem = legal(self.catalog, pick["provider"], pick["model"], pick["effort"])
                    self.assertIsNone(problem, f"{role} on {subset}")

    def test_tiered_teams_normal_and_lean_are_legal(self) -> None:
        cfg = example_config()
        for size in range(1, 4):
            for subset in itertools.combinations(("agy_sub", "claude_sub", "codex_sub", "dsh_opencode", "gemini_sub"), size):
                providers = tuple(ProviderReadiness(p, "cli", p in subset, p in subset) for p in cfg.providers)
                for lean in (False, True):
                    lineup = _tiered_lineup(cfg, providers, self.catalog, lean=lean)
                    for role, spec in (lineup or {"model_overrides": {}})["model_overrides"].items():
                        provider, model, effort = model_catalog.split_spec(spec)
                        with self.subTest(subset=subset, lean=lean, role=role):
                            self.assertIsNone(legal(self.catalog, provider, model, effort))

    def test_shipped_presets_and_example_config_are_legal(self) -> None:
        sources = {path.name: json.loads(path.read_text(encoding="utf-8")) for path in (ROOT / "presets").glob("*.json")}
        sources["baton.example.toml"] = tomllib.loads((ROOT / "baton.example.toml").read_text(encoding="utf-8"))
        checked = 0
        for name, document in sources.items():
            for path, provider, spec in specs_in(document):
                if provider in UNCHECKED_PROVIDERS:
                    continue
                model, at, effort = spec.rpartition("@")
                if not at:
                    model, effort = spec, ""
                checked += 1
                with self.subTest(source=name, path=path, spec=f"{provider}:{spec}"):
                    # Claude aliases (opus, sonnet, haiku, fable) map to catalog IDs only for this check.
                    self.assertIsNone(legal(self.catalog, provider, model, effort))
        self.assertGreater(checked, 20)


class EffortSourceTests(unittest.TestCase):
    def test_dsh_patch_file_is_the_source_for_dsh_opencode(self) -> None:
        text = (ROOT / "presets" / model_catalog.DSH_PATCH_FILE).read_text(encoding="utf-8")
        self.assertEqual(model_catalog.parse_dsh_patch_efforts(text), {
            "deepseek-v4.1-flash": ["low", "high", "max"],
            "deepseek-v4-pro": ["high", "max"],
            "glm-5.3": [],
            "glm-5.2": [],
        })
        flash = next(e for e in fixture_catalog() if e["id"] == "deepseek-v4.1-flash")
        self.assertEqual(flash["provider_efforts"]["dsh_opencode"], ["low", "high", "max"])
        self.assertEqual(flash["effort_sources"]["dsh_opencode"], "cli_models")

    def test_dsh_parser_ignores_other_blocks_and_unknown_levels(self) -> None:
        text = (
            "- id: credentials\n  disabled: false\n"
            "- id: llm\n  config:\n    providers:\n      p:\n        models:\n"
            "          - id: m1\n            reasoningEfforts:\n              off: null\n              low: low\n"
            "              turbo: turbo\n            input:\n              - text\n"
            "          - id: m2\n            name: M2\n"
            "- id: agent-default-model\n  config:\n    model: m1\n"
        )
        self.assertEqual(model_catalog.parse_dsh_patch_efforts(text), {"m1": ["low"], "m2": []})

    def test_claude_help_effort_line(self) -> None:
        help_text = ("  --effort <level>                      Effort level for the current session\n"
                     "                                        (low, medium, high, xhigh, max)\n  --model <m>  Model\n")
        self.assertEqual(model_catalog.parse_claude_effort_help(help_text), ["low", "medium", "high", "xhigh", "max"])
        self.assertIsNone(model_catalog.parse_claude_effort_help("  --model <m>  Model\n"))

    def test_feed_flags_become_effort_sets(self) -> None:
        derive = model_catalog.feed_reasoning_efforts
        self.assertIsNone(derive({}))
        # The feed leaves false flags out: a chat row without supports_reasoning takes no effort.
        self.assertEqual(derive({"mode": "chat", "litellm_provider": "openai"}), [])
        self.assertEqual(derive({"supports_reasoning": False}), [])
        self.assertEqual(derive({"supports_reasoning": True}), ["low", "medium", "high"])
        self.assertEqual(derive({"supports_reasoning": True, "supports_minimal_reasoning_effort": True,
                                 "supports_xhigh_reasoning_effort": True, "supports_max_reasoning_effort": True}),
                         ["minimal", "low", "medium", "high", "xhigh", "max"])
        self.assertEqual(derive({"supports_reasoning": True, "supports_low_reasoning_effort": False}), ["medium", "high"])
        self.assertEqual(derive({"supports_reasoning": True, "reasoning_effort_levels": ["none", "low", "high", "turbo"]}),
                         ["low", "high"])

    def test_source_order_and_default(self) -> None:
        catalog = fixture_catalog()
        by_id = {entry["id"]: entry for entry in catalog}
        self.assertEqual(by_id["gemini-4-carbon"]["provider_efforts"]["agy_sub"], ["low", "medium", "high"])
        self.assertEqual(by_id["gemini-4-hydrogen"]["provider_efforts"]["agy_sub"], ["low", "medium", "high", "xhigh"])
        self.assertEqual(by_id["gemini-2.5-pro"]["provider_efforts"]["gemini_sub"], [])
        self.assertEqual(by_id["gemini-2.5-pro"]["effort_sources"]["gemini_sub"], "cli_declared")
        self.assertEqual(by_id["claude-sonnet-5-5"]["effort_sources"],
                         {"claude_sub": "cli_declared", "agy_sub": "cli_models"})
        self.assertEqual(by_id["gpt-4o"]["provider_efforts"]["openai_http"], [])
        self.assertEqual(by_id["gpt-5"]["effort_sources"]["openai_http"], "feed")
        self.assertEqual(by_id["gpt-5-mini"]["provider_efforts"]["openai_http"], ["low", "medium", "high"])
        self.assertEqual(by_id["gpt-5-mini"]["effort_sources"]["openai_http"], "default")
        # The bundled roster alone never claims more than low/medium/high for an unverified model.
        bundled = model_catalog.ensure_resolved(model_catalog.BUNDLED_MODELS)
        self.assertTrue(all(len(e["provider_efforts"][p]) <= 3 for e in bundled for p in e["providers"]
                            if e["effort_sources"][p] == "default"))


class NormalizeSpecTests(unittest.TestCase):
    def setUp(self) -> None:
        self.catalog = fixture_catalog()

    def test_rules(self) -> None:
        normalize = model_catalog.normalize_spec
        flash = normalize("dsh_opencode", "deepseek-v4.1-flash", "medium", self.catalog)
        self.assertEqual((flash["spec"], flash["changed"], flash["reason"]),
                         ("dsh_opencode:deepseek-v4.1-flash@max", True, "effort_adjusted"))
        pro = normalize("dsh_opencode", "deepseek-v4-pro", "low", self.catalog)
        self.assertEqual(pro["effort"], "high")  # the default high is legal for v4-pro
        oss = normalize("agy_sub", "gpt-oss-120b", "high", self.catalog)
        self.assertEqual(oss["effort"], "medium")  # only medium exists; default high -> closest lower
        gemini_cli = normalize("gemini_sub", "gemini-2.5-pro", "high", self.catalog)
        self.assertEqual((gemini_cli["spec"], gemini_cli["reason"]), ("gemini_sub:gemini-2.5-pro", "effort_removed"))
        kept = normalize("codex_sub", "gpt-6.2-sol", "max", self.catalog)
        self.assertEqual((kept["changed"], kept["reason"]), (False, "ok"))
        alias = normalize("claude_sub", "opus", "max", self.catalog)
        self.assertEqual((alias["spec"], alias["reason"]), ("claude_sub:opus@max", "ok"))  # alias kept as written
        unknown = normalize("claude_sub", "claude-zeta-9", "turbo", self.catalog)
        self.assertEqual((unknown["spec"], unknown["changed"], unknown["reason"]),
                         ("claude_sub:claude-zeta-9@turbo", False, "unverifiable"))
        wrong_tool = normalize("gemini_sub", "gemini-4-carbon", "medium", self.catalog)
        self.assertEqual(wrong_tool["reason"], "unverifiable")  # never swaps the model

    def test_string_form_and_legacy_claude_ids_still_resolve(self) -> None:
        from vibebaton.config import _LEGACY_CLAUDE_MODEL_IDS

        result = model_catalog.normalize_spec_string("dsh_opencode:deepseek-v4.1-flash@medium", self.catalog)
        self.assertEqual(result["spec"], "dsh_opencode:deepseek-v4.1-flash@max")
        same = model_catalog.normalize_spec_string("codex_sub:gpt-6.2-sol@max", self.catalog)
        self.assertEqual(same["spec"], "codex_sub:gpt-6.2-sol@max")
        # The legacy Claude ID migration is separate and unaffected: its targets are catalog models.
        for target in _LEGACY_CLAUDE_MODEL_IDS.values():
            self.assertIsNotNone(model_catalog.find_catalog_model("claude_sub", target, self.catalog), target)


if __name__ == "__main__":
    unittest.main()
