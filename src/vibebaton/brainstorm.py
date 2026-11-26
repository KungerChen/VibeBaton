"""Guided-mode architecture brainstorm: multi-turn chat -> RFC draft -> Blueprint Card contracts.

Copy rule: every string here addresses the user as the Lead Architect of the project.
No condescending labels (see the anti-condescension guard in the Stage 6 RFC).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Literal, TypedDict

from .config import BatonConfig, ProviderConfig
from .rfc_checker import RFCReadiness, check_rfc_readiness

RFC_RELATIVE_PATH = Path(".baton") / "00_RFC.md"
OFFLINE_ENV_VARS = ("VIBEBATON_OFFLINE_BRAINSTORM", "VIBEBATON_BRAINSTORM_OFFLINE")
REQUIRED_HEADINGS = (
    "Goals",
    "Constraints",
    "Non-Goals",
    "Architecture & Deliverables",
    "Verification & Acceptance Criteria",
)

# A live dispatcher takes the full prompt and returns ``(provider_id, raw_response_text)``.
BrainstormDispatch = Callable[[str], tuple[str, str]]


class ChatMessage(TypedDict):
    role: Literal["user", "assistant"]
    content: str


class BlueprintCard(TypedDict):
    title: str
    summary: str
    deliverables: list[str]
    touched_areas: list[str]
    verification_plan: list[str]
    readiness_score: int  # 0-100, mirrors check_rfc_readiness(rfc_markdown)["score"]
    ready_to_launch: bool


class BrainstormTurnResult(TypedDict):
    reply: str
    rfc_markdown: str
    blueprint: BlueprintCard
    provider_used: str | None  # None when the deterministic offline fallback produced the turn
    offline: bool


class BlueprintConfirmResult(TypedDict):
    rfc_path: str  # absolute path of the written .baton/00_RFC.md
    readiness: RFCReadiness
    ready_to_launch: bool


class BrainstormScenario(TypedDict):
    id: str
    title_en: str
    title_zh: str
    prompt_en: str
    prompt_zh: str


# Every starter ends with the same four prompts, one per line, so the first message already
# carries the outcome, the audience, the limits, and the finish line.
_SCENARIO_FIELDS_EN = ("Result I want:", "Who uses it or is affected:", "What must not change:", "How we know it is done:")
_SCENARIO_FIELDS_ZH = ("想达到的结果：", "给谁用 / 会影响谁：", "不能动的东西：", "怎么算完成：")


def _scenario(scenario_id: str, title_en: str, title_zh: str, intro_en: str, intro_zh: str) -> BrainstormScenario:
    return {
        "id": scenario_id,
        "title_en": title_en,
        "title_zh": title_zh,
        "prompt_en": "\n".join((intro_en, *_SCENARIO_FIELDS_EN)),
        "prompt_zh": "\n".join((intro_zh, *_SCENARIO_FIELDS_ZH)),
    }


# Mirrored for the Studio in web/src/components/guided/brainstormScenarios.json (a test keeps them equal).
SCENARIOS: tuple[BrainstormScenario, ...] = (
    _scenario(
        "new_feature", "Ship a new feature", "交付一个新功能",
        "I want to add a new feature.", "我想增加一个新功能。",
    ),
    _scenario(
        "bug_fix", "Fix a bug for good", "彻底修复一个缺陷",
        "Something is broken. What happens now, and how to make it happen:",
        "有个地方出了问题。现在的表现和复现步骤：",
    ),
    _scenario(
        "refactor", "Refactor safely", "安全地重构",
        "I want to restructure this part of the code without changing what it does:",
        "我想在不改变行为的前提下重新整理这部分代码：",
    ),
    _scenario(
        "add_tests", "Strengthen test coverage", "加强测试覆盖",
        "I want automated tests that protect these key behaviors:",
        "我想用自动化测试守住这些关键行为：",
    ),
    _scenario(
        "web_app", "Start a small web app", "从零搭建一个小型网页应用",
        "I want to build a small web app. Its main pages and what each one does:",
        "我想做一个小型网页应用，主要页面和各自的作用：",
    ),
    _scenario(
        "performance", "Make it faster", "优化性能",
        "Something is too slow. Where it is slow, and roughly how slow it is now:",
        "有个地方太慢了。慢在哪里、现在大概有多慢：",
    ),
    _scenario(
        "ui_redesign", "Redesign the interface", "界面改版",
        "I want to change how this part of the interface looks or works:",
        "我想调整这部分界面的样子或操作方式：",
    ),
    _scenario(
        "dependency_upgrade", "Upgrade or migrate a dependency", "升级或迁移依赖",
        "I want to upgrade or replace this dependency (current version, target version):",
        "我想升级或替换这个依赖（现在的版本、目标版本）：",
    ),
    _scenario(
        "write_docs", "Write documentation", "编写文档",
        "I want documentation that explains:",
        "我想补一份文档，讲清楚这些内容：",
    ),
    _scenario(
        "script_or_data", "Write a script or process data", "写脚本或处理数据",
        "I want a script for this job (what goes in, what should come out):",
        "我想写个脚本来做这件事（输入是什么、输出成什么样）：",
    ),
    _scenario(
        "not_sure", "Not sure yet, help me think it through", "还没想清楚，帮我梳理",
        "I have not fully worked it out yet. The rough idea (fill in what you can, blanks are fine):",
        "我还没完全想清楚，先说说大概的想法（下面能写多少写多少，空着也没关系）：",
    ),
)

_SYSTEM_PROMPT = """You are the architecture partner of the Lead Architect of this repository.
Reply in the same language the Lead Architect writes in (Chinese if they write in Chinese,
English if they write in English). Format your conversational reply before the RFC block in clean
Markdown: use short paragraphs, **bold** for key terms, bullet or numbered lists for options or
questions, and `backticks` for commands and file paths. Talk with them in plain, warm language:
summarise what you understood, then ask at most two focused questions about whatever is still open
(goals, limits, out-of-scope items, or the exact command that proves the work is done). Keep the
formal RFC section headings below in English so the readiness checker can parse them accurately.

The Lead Architect may not be a software engineer. Use plain words and explain any technical
term you need in a few words.
If they cannot name a verification command, do not keep asking: propose one yourself that fits
the project (prefer the detected commands in the project summary), say in one sentence what it
checks, and put it in the RFC so they can confirm or change it.
Never invent file paths. Only cite paths that appear in the project summary or that the Lead
Architect mentioned; otherwise describe the area in words.
If the request is clearly too big for one build, suggest splitting it into a few steps, write the
RFC for only the first step, and list the later steps under Non-Goals.

After your reply, include the complete, updated Master RFC inside a fenced block that opens
with ````rfc and closes with ```` (four backticks), so inner ``` code blocks stay intact.
The RFC must start with a "# <title>" line and use exactly these second-level headings, in order:
## Goals              (one summary paragraph, then one "- " bullet per deliverable)
## Constraints        ("- " bullets)
## Non-Goals          ("- " bullets)
## Architecture & Deliverables  ("- " bullets; wrap file paths and modules in `backticks`)
## Verification & Acceptance Criteria  (numbered criteria, then a ```bash block with the
                      verification command once one is named or proposed)
Avoid placeholder words such as TBD or TODO; leave an item out until it is known."""

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+|[。！？；\n]+")
_COMMAND_START = re.compile(
    r"\b(?:python3?|py|pytest|npm|npx|pnpm|yarn|vitest|cargo|go|make|dotnet|mvnw?|gradlew?)\b",
    re.IGNORECASE,
)
_CONSTRAINT_WORDS = re.compile(
    r"\b(?:must|only|without|keep|stdlib|standard library|never|no new|avoid)\b|必须|只能|不要|不能|保持",
    re.IGNORECASE,
)
_NON_GOAL_WORDS = re.compile(
    r"\b(?:not needed|out of scope|no need|later|non-goal|skip)\b|不需要|暂不|以后",
    re.IGNORECASE,
)
_FILE_TOKEN = re.compile(
    r"(?<![\w/`])(?:[\w.-]+/)*[\w-]+\.(?:py|pyi|ts|tsx|js|jsx|json|toml|md|css|html|go|rs|java|cs)\b"
)
_INLINE_CODE = re.compile(r"(?<!`)`([^`\s]+)`(?!`)")
_FENCE_LINE = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})(.*)$")
_RFC_OPEN = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})[ \t]*rfc[ \t]*$", re.IGNORECASE)
_BULLET = re.compile(r"^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?P<text>\S.*)$")


PROJECT_CONTEXT_MAX_CHARS = 4000
_CONTEXT_SKIP_DIRS = frozenset({
    ".git", "node_modules", ".baton", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache",
    ".ruff_cache", ".tox", ".idea", ".vscode", "dist", "build", ".next", ".cache", ".bootstrap-runner",
})
# Names that may hold secrets are neither listed nor read.
_SENSITIVE_NAME = re.compile(
    r"^\.env|credential|secret|password|token|\.pem$|\.key$|^id_(?:rsa|ed25519|ecdsa)", re.IGNORECASE,
)
_README_NAMES = ("README.md", "README.rst", "README.txt", "README")
_README_HEAD_LINES = 20
# README layout markup and badge rows say little about the project; the head keeps prose lines.
_README_MARKUP_LINE = re.compile(r"^\s*(?:<|\[!\[|!\[)")
_TOP_LEVEL_LIMIT = 40
_BLANK_FIELD = re.compile(r"^[^:：]{1,40}[:：]$")


def _is_blank_field(sentence: str) -> bool:
    """A starter prompt line such as "Result I want:" that the user left empty."""
    return bool(_BLANK_FIELD.match(sentence.strip()))


def _read_head(path: Path, max_lines: int) -> list[str]:
    lines: list[str] = []
    try:
        with path.open(encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if len(lines) >= max_lines:
                    break
                if _README_MARKUP_LINE.match(line) or (not line.strip() and (not lines or not lines[-1])):
                    continue
                lines.append(line.rstrip()[:200])
    except OSError:
        return []
    while lines and not lines[-1].strip():
        lines.pop()
    return lines


def _detected_commands(repo: Path, folders: list[Path]) -> list[str]:
    """Test/build commands declared in package.json scripts (root and first-level folders) and pyproject.toml."""
    commands: list[str] = []
    for folder in [repo, *folders]:
        try:
            scripts = json.loads((folder / "package.json").read_text(encoding="utf-8")).get("scripts")
        except (OSError, ValueError, AttributeError):
            continue
        prefix = "" if folder == repo else f"cd {folder.name} && "
        source = "package.json" if folder == repo else f"{folder.name}/package.json"
        for name, command in (scripts.items() if isinstance(scripts, dict) else []):
            if isinstance(name, str) and isinstance(command, str):
                commands.append(f"{prefix}npm run {name}  ({source}: {command[:120]})")
    try:
        pyproject = (repo / "pyproject.toml").read_text(encoding="utf-8")
    except OSError:
        pyproject = None
    if pyproject is not None:
        if "pytest" in pyproject:
            commands.append("python -m pytest  (pyproject.toml)")
        elif (repo / "tests").is_dir():
            commands.append("python -m unittest discover -s tests  (pyproject.toml, tests/)")
    return commands[:20]


def project_context(repo_path: Path, *, max_chars: int = PROJECT_CONTEXT_MAX_CHARS) -> str:
    """Read-only summary for the brainstorm prompt: project name, top-level entries, README head,
    detected test/build commands. Skips dependency/tool folders and never lists or reads secret-like files.
    """
    repo = Path(repo_path)
    lines = [f"Project name: {repo.resolve().name or repo}"]
    try:
        entries = sorted(repo.iterdir(), key=lambda entry: entry.name.lower())
    except OSError:
        entries = []
    visible = [e for e in entries if e.name not in _CONTEXT_SKIP_DIRS and not _SENSITIVE_NAME.search(e.name)]
    if visible:
        shown = [e.name + ("/" if e.is_dir() else "") for e in visible[:_TOP_LEVEL_LIMIT]]
        lines.append("Top-level entries: " + ", ".join(shown))
    readme = next((repo / name for name in _README_NAMES if (repo / name).is_file()), None)
    head = _read_head(readme, _README_HEAD_LINES) if readme is not None else []
    if head:
        lines += ["", f"{readme.name} (first lines):", *head]
    commands = _detected_commands(repo, [e for e in visible if e.is_dir()])
    if commands:
        lines += ["", "Detected test/build commands:", *(f"- {command}" for command in commands)]
    text = "\n".join(lines)
    return text if len(text) <= max_chars else text[: max(0, max_chars - 3)].rstrip() + "..."


def _offline_requested() -> bool:
    return any(os.environ.get(name, "").strip() == "1" for name in OFFLINE_ENV_VARS)


def _validate(messages: list[ChatMessage], scenario: str | None) -> BrainstormScenario | None:
    if not isinstance(messages, list) or not messages:
        raise ValueError("messages must be a non-empty list of {role, content} objects.")
    for message in messages:
        if (
            not isinstance(message, dict)
            or message.get("role") not in ("user", "assistant")
            or not isinstance(message.get("content"), str)
        ):
            raise ValueError("Each message needs role 'user' or 'assistant' and string content.")
    if messages[-1]["role"] != "user" or not messages[-1]["content"].strip():
        raise ValueError("The conversation must end with a non-empty user message.")
    if scenario is None:
        return None
    for item in SCENARIOS:
        if item["id"] == scenario:
            return item
    raise ValueError(f"Unknown scenario {scenario!r}.")


def _sentences(text: str) -> list[str]:
    return [part.strip() for part in _SENTENCE_SPLIT.split(text) if part and part.strip()]


def _extract_command(sentence: str) -> str | None:
    """Return the verification command named in ``sentence`` (backticked or trailing), if any."""
    backticked = [token for token in re.findall(r"`([^`]+)`", sentence) if _COMMAND_START.match(token)]
    if backticked:
        return backticked[0].strip()
    if not check_rfc_readiness(sentence)["detected_commands"]:
        return None
    match = _COMMAND_START.search(sentence)
    if match is None:
        return None
    return sentence[match.start():].strip().rstrip(".;,。；，").strip() or None


def _compose_offline_rfc(messages: list[ChatMessage]) -> tuple[str, bool]:
    """Synthesise the RFC from user turns only and report whether user constraints were given."""
    user_turns = [m["content"].strip() for m in messages if m["role"] == "user" and m["content"].strip()]
    all_sentences = [s for text in user_turns for s in _sentences(text)]
    sentences = [s for s in all_sentences if not _is_blank_field(s)] or all_sentences
    if not sentences:
        sentences = user_turns or ["Untitled Draft"]
    first, rest = sentences[0], sentences[1:]
    title = first.rstrip(".!?。！？").strip() or first
    if len(title) > 80:
        title = title[:77].rstrip() + "…"

    goals: list[str] = []
    constraints: list[str] = []
    non_goals: list[str] = []
    commands: list[str] = []
    for sentence in rest:
        command = _extract_command(sentence)
        if command is not None:
            if command not in commands:
                commands.append(command)
            sentence = sentence.replace(f"`{command}`", "").replace(command, "")
            sentence = re.sub(r"\s+", " ", sentence).strip(" .;,:-`。；，")
            sentence = re.sub(r"[;,]?\s*\b(?:verify|verified|check|checked|test|tested)\s+(?:with|by|using)$", "", sentence)
            if not sentence.strip(" .;,:"):
                continue
        if _NON_GOAL_WORDS.search(sentence):
            non_goals.append(sentence)
        elif _CONSTRAINT_WORDS.search(sentence):
            constraints.append(sentence)
        else:
            goals.append(sentence)

    areas: list[str] = []
    for text in sentences:
        for token in [*_INLINE_CODE.findall(text), *_FILE_TOKEN.findall(text)]:
            if token not in areas and not _COMMAND_START.match(token):
                areas.append(token)

    def bullets(items: list[str], default: str) -> list[str]:
        return [f"- {item}" for item in items] if items else [f"- {default}"]

    verification = ["1. Every goal listed above is covered by an automated check."]
    if commands:
        verification.append("2. The verification command below exits successfully.")
        verification += ["", "````bash", *commands, "````"]
    else:
        verification.append("2. The existing automated checks of the project keep passing.")

    lines = [
        f"# {title}",
        "",
        "## Goals",
        "",
        first,
        "",
        *bullets([first, *goals], first),
        "",
        "## Constraints",
        "",
        *bullets(constraints, "Keep current behaviour and public interfaces stable outside the goals above."),
        "",
        "## Non-Goals",
        "",
        *bullets(non_goals, "Changes unrelated to the goals above."),
        "",
        "## Architecture & Deliverables",
        "",
        *bullets([f"`{area}`" for area in areas], "Implementation areas are chosen during planning."),
        "",
        "## Verification & Acceptance Criteria",
        "",
        *verification,
        "",
    ]
    return "\n".join(lines), bool(constraints)


def _offline_rfc(messages: list[ChatMessage]) -> str:
    """Synthesise the RFC from user turns only: title from the first sentence, bullets from the rest."""
    return _compose_offline_rfc(messages)[0]


def _prefers_zh(messages: list[ChatMessage], locale: str | None) -> bool:
    if isinstance(locale, str) and locale.strip().lower().startswith("zh"):
        return True
    if isinstance(locale, str) and locale.strip().lower().startswith("en"):
        return False
    latest_user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
    return any("\u4e00" <= ch <= "\u9fff" for ch in latest_user)


def _offline_reply(
    rfc_markdown: str,
    readiness: RFCReadiness,
    scenario: BrainstormScenario | None,
    *,
    zh: bool = False,
    has_custom_constraints: bool | None = None,
) -> str:
    title = rfc_markdown.splitlines()[0][2:].strip()
    if has_custom_constraints is None:
        has_custom_constraints = "- Keep current behaviour and public interfaces stable" not in rfc_markdown
    if zh:
        lead = f"从「{scenario['title_zh']}」出发，" if scenario else ""
        parts = [f"{lead}这是「{title}」的最新蓝图草案。"]
        if not readiness["detected_commands"]:
            parts.append("要如何证明它已经生效？请写一条用来验证的命令（例如 npm test 或 pytest）。")
        if not has_custom_constraints:
            parts.append("是否有需要遵守的边界条件（例如限制使用的依赖库或不要修改的文件）？")
        if len(parts) == 1:
            parts.append("目标、边界和验证命令均已齐备；核对无误后点击「确认蓝图并开始施工」即可出发。")
        return " ".join(parts)

    lead = f'Starting from "{scenario["title_en"]}", ' if scenario else ""
    parts = [f'{lead}here is the current blueprint for "{title}".']
    if not readiness["detected_commands"]:
        parts.append("How should we prove it works? Name the command you run to test it (for example npm test or pytest).")
    if not has_custom_constraints:
        parts.append("Are there limits to respect, such as libraries to avoid or files to leave untouched?")
    if len(parts) == 1:
        parts.append('It has goals, limits, and a verification command; review it and click "Confirm Blueprint & Start Building" when it reads right.')
    return " ".join(parts)


def _section_lines(rfc_markdown: str) -> dict[str, list[str]]:
    """Map each lower-cased ``## `` heading to its body lines, skipping fenced code."""
    sections: dict[str, list[str]] = {}
    current: str | None = None
    fence: str | None = None
    for line in rfc_markdown.splitlines():
        fence_match = _FENCE_LINE.match(line)
        if fence is not None:
            if fence_match and fence_match.group(1).startswith(fence) and not fence_match.group(2).strip():
                fence = None
            continue
        if fence_match:
            fence = fence_match.group(1)
            continue
        if line.startswith("## "):
            current = line[3:].strip().lower()
            sections.setdefault(current, [])
        elif current is not None:
            sections[current].append(line)
    return sections


def _has_required_headings(rfc_markdown: str) -> bool:
    sections = _section_lines(rfc_markdown)
    return rfc_markdown.startswith("# ") and all(h.lower() in sections for h in REQUIRED_HEADINGS)


def _blueprint(rfc_markdown: str) -> BlueprintCard:
    readiness = check_rfc_readiness(rfc_markdown)
    sections = _section_lines(rfc_markdown)
    goal_lines = next((lines for name, lines in sections.items() if name.startswith("goal")), [])
    paragraphs: list[str] = []
    deliverables: list[str] = []
    current: list[str] = []
    for line in [*goal_lines, ""]:
        bullet = _BULLET.match(line)
        if bullet:
            deliverables.append(bullet.group("text").strip())
        elif line.strip():
            current.append(line.strip())
            continue
        if current:
            paragraphs.append(" ".join(current))
            current = []
    summary = paragraphs[0] if paragraphs else (deliverables[0] if deliverables else "")

    body = "\n".join(line for lines in sections.values() for line in lines)
    touched: list[str] = []
    for token in _INLINE_CODE.findall(body):
        if token not in touched and not check_rfc_readiness(token)["detected_commands"]:
            touched.append(token)

    title_line = next((line for line in rfc_markdown.splitlines() if line.startswith("# ")), "# ")
    return {
        "title": title_line[2:].strip(),
        "summary": summary,
        "deliverables": deliverables,
        "touched_areas": touched,
        "verification_plan": list(readiness["detected_commands"]),
        "readiness_score": max(0, min(100, int(readiness["score"]))),
        "ready_to_launch": bool(readiness["safe_for_overnight"]),
    }


def _build_prompt(
    messages: list[ChatMessage],
    scenario: BrainstormScenario | None,
    *,
    locale: str | None = None,
    project: str | None = None,
) -> str:
    parts = [_SYSTEM_PROMPT, ""]
    if _prefers_zh(messages, locale):
        parts += ["Respond in natural Chinese (while keeping formal RFC headings in English).", ""]
    if project:
        parts += ["Project summary (read-only; you cannot open or change files):", project, ""]
    if scenario is not None:
        parts += [f"Starting scenario: {scenario['title_en']}", ""]
    parts.append("Conversation so far:")
    for message in messages:
        speaker = "Lead Architect" if message["role"] == "user" else "You"
        parts += ["", f"[{speaker}]", message["content"].strip()]
    return "\n".join(parts) + "\n"


def _split_live_response(text: str) -> tuple[str, str]:
    """Return ``(reply, rfc_markdown)`` from a live response; ``ValueError`` when no usable RFC."""
    lines = text.replace("\r\n", "\n").split("\n")
    start = next((i for i, line in enumerate(lines) if _RFC_OPEN.match(line)), None)
    if start is None:
        raise ValueError("Live response has no fenced rfc block.")
    opener = _RFC_OPEN.match(lines[start]).group(1)
    end = None
    for i in range(len(lines) - 1, start, -1):  # last bare closing fence: inner ``` blocks survive
        match = _FENCE_LINE.match(lines[i])
        if (
            match
            and match.group(1)[0] == opener[0]
            and len(match.group(1)) >= len(opener)
            and not match.group(2).strip()
        ):
            end = i
            break
    if end is None:
        raise ValueError("Live response rfc block is not closed.")
    rfc_markdown = "\n".join(lines[start + 1:end]).strip() + "\n"
    if not _has_required_headings(rfc_markdown):
        raise ValueError("Live RFC is missing the required headings.")
    reply = "\n".join([*lines[:start], *lines[end + 1:]]).strip()
    return reply or "The blueprint below reflects our conversation so far.", rfc_markdown


def _provider_dispatch(cfg: BatonConfig, model_overrides: dict[str, str] | None = None) -> BrainstormDispatch | None:
    """Return a dispatcher for the first ready configured provider, preferring planning roles.

    When ``model_overrides`` names the L0 role (the Guided lineup's choice), that provider and model
    go first; if it is unknown or not ready, the configured roles are tried as before.
    """
    from .credentials import probe_role_or_provider

    l0_role = "brainstorm_and_final_gate"
    if model_overrides and l0_role in model_overrides and l0_role in cfg.roles:
        try:
            chosen_role, chosen_provider = cfg.resolve_role(l0_role, model_overrides)
        except KeyError:
            chosen_provider = None
        if chosen_provider is not None and probe_role_or_provider(cfg, provider=chosen_provider.name)["ok"]:
            return lambda prompt, p=chosen_provider, m=chosen_role.model: _invoke(cfg, p, m, prompt)

    preferred = ("brainstorm_and_final_gate", "tactical_planner", "milestone_reviewer", "critical_executor")
    seen: set[str] = set()
    for role_name in dict.fromkeys((*preferred, *cfg.roles)):
        role = cfg.roles.get(role_name)
        provider = cfg.providers.get(role.provider) if role is not None else None
        if provider is None or provider.name in seen:
            continue
        seen.add(provider.name)
        if probe_role_or_provider(cfg, provider=provider.name)["ok"]:
            return lambda prompt, p=provider, m=role.model: _invoke(cfg, p, m, prompt)
    return None


def _invoke(cfg: BatonConfig, provider: ProviderConfig, model: str, prompt: str) -> tuple[str, str]:
    """Run one prompt through the engine's provider path inside a throwaway directory.

    Coding-agent CLIs run with write permissions in their ``cwd``, so the repository is never
    their working directory: whatever the agent writes is discarded with the temp dir.
    """
    from .cli_runner import invoke_provider

    transport_model, effort = model, None
    if provider.type == "http":
        transport_model, _, effort_suffix = model.partition("@")
        effort = effort_suffix or None
    with tempfile.TemporaryDirectory(prefix="vibebaton-brainstorm-") as tmp:
        workspace = Path(tmp) / "workspace"
        workspace.mkdir()
        result = asyncio.run(invoke_provider(
            provider,
            model=transport_model,
            effort=effort,
            prompt=prompt,
            cwd=workspace,
            prompt_file=Path(tmp) / "prompt.md",
            output_file=Path(tmp) / "out.json",
            pricing_settings=cfg.pricing,
            default_stall_timeout=cfg.daemon.default_stall_timeout_sec,
            default_hard_timeout=cfg.daemon.default_hard_timeout_sec,
        ))
    if result.status != "ok":
        raise RuntimeError(f"{provider.name} returned {result.status}: {(result.stderr or result.stdout)[:200]}")
    return provider.name, result.text


def brainstorm_turn(
    repo_path: Path,
    messages: list[ChatMessage],
    scenario: str | None = None,
    cfg: BatonConfig | None = None,
    *,
    dispatch: BrainstormDispatch | None = None,
    locale: str | None = None,
    model_overrides: dict[str, str] | None = None,
) -> BrainstormTurnResult:
    """Run one brainstorm turn and return the reply, a full RFC draft and its Blueprint Card.

    Contract:
    - ``messages`` is the full conversation so far (oldest first) and must end with a ``user``
      message; empty/invalid conversations or an unknown ``scenario`` id -> ``ValueError``.
    - Live path: ``dispatch`` (``prompt -> (provider_id, text)``) when given, otherwise the L0
      choice in ``model_overrides`` or the first ready provider of ``cfg`` via
      ``cli_runner.invoke_provider``. The prompt carries a read-only ``project_context`` summary. The response must carry a
      fenced ``rfc`` block with every required heading; ``provider_used`` is the provider id.
    - Offline path: env ``VIBEBATON_OFFLINE_BRAINSTORM=1`` (or ``VIBEBATON_BRAINSTORM_OFFLINE=1``),
      no dispatcher and no ready provider, or any live failure uses the deterministic offline
      composer: same input -> same output, ``offline=True``, ``provider_used=None``.
    - ``rfc_markdown`` always starts with ``"# "`` and has ``## Goals``, ``## Constraints``,
      ``## Non-Goals``, ``## Architecture & Deliverables`` and ``## Verification & Acceptance
      Criteria`` headings. ``blueprint.readiness_score`` equals its readiness score and
      ``ready_to_launch`` equals its ``safe_for_overnight``.
    - Never writes to the repository; ``confirm_blueprint`` persists the draft.
    """
    chosen = _validate(messages, scenario)
    if not _offline_requested():
        try:
            if dispatch is None and cfg is not None:
                dispatch = _provider_dispatch(cfg, model_overrides)
            if dispatch is not None:
                prompt = _build_prompt(messages, chosen, locale=locale, project=project_context(repo_path))
                provider_used, text = dispatch(prompt)
                reply, rfc_markdown = _split_live_response(text)
                return {
                    "reply": reply,
                    "rfc_markdown": rfc_markdown,
                    "blueprint": _blueprint(rfc_markdown),
                    "provider_used": provider_used,
                    "offline": False,
                }
        except Exception:  # noqa: BLE001 - any live failure degrades to the offline composer
            pass

    rfc_markdown, has_custom_constraints = _compose_offline_rfc(messages)
    return {
        "reply": _offline_reply(
            rfc_markdown,
            check_rfc_readiness(rfc_markdown),
            chosen,
            zh=_prefers_zh(messages, locale),
            has_custom_constraints=has_custom_constraints,
        ),
        "rfc_markdown": rfc_markdown,
        "blueprint": _blueprint(rfc_markdown),
        "provider_used": None,
        "offline": True,
    }


def confirm_blueprint(
    repo_path: Path,
    rfc_markdown: str,
    cfg: BatonConfig | None = None,
) -> BlueprintConfirmResult:
    """Atomically write ``rfc_markdown`` to ``<repo>/.baton/00_RFC.md`` and score it.

    Contract:
    - ``repo_path`` that is not a directory, or blank ``rfc_markdown`` -> ``ValueError`` and
      nothing is written.
    - Creates ``.baton/`` when needed, writes UTF-8 with LF line endings through a temp file and
      ``os.replace`` (no temp file survives), returns the absolute ``rfc_path``,
      ``readiness = check_rfc_readiness(rfc_markdown)`` and
      ``ready_to_launch = readiness["safe_for_overnight"]``.
    """
    repo = Path(repo_path)
    if not repo.is_dir():
        raise ValueError(f"Repository path is not a directory: {repo}")
    if not isinstance(rfc_markdown, str) or not rfc_markdown.strip():
        raise ValueError("rfc_markdown must be non-blank text.")
    text = rfc_markdown.replace("\r\n", "\n").replace("\r", "\n")
    target = (repo / RFC_RELATIVE_PATH).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=".00_RFC.", suffix=".tmp", dir=target.parent)
    try:
        with open(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(tmp_name, target)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise
    readiness = check_rfc_readiness(text)
    return {
        "rfc_path": str(target),
        "readiness": readiness,
        "ready_to_launch": readiness["safe_for_overnight"],
    }
