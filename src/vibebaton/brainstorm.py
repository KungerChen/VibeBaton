"""Guided-mode architecture brainstorm: multi-turn chat -> RFC draft -> Blueprint Card contracts.

Copy rule: every string here addresses the user as the Lead Architect of the project.
No condescending labels (see the anti-condescension guard in the Stage 6 RFC).
"""

from __future__ import annotations

import asyncio
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


SCENARIOS: tuple[BrainstormScenario, ...] = (
    {
        "id": "new_feature",
        "title_en": "Ship a new feature",
        "title_zh": "交付一个新功能",
        "prompt_en": "I want to add a new feature. Here is what it should do for the people using it:",
        "prompt_zh": "我想增加一个新功能，它应该为使用者带来这些能力：",
    },
    {
        "id": "bug_fix",
        "title_en": "Fix a bug for good",
        "title_zh": "彻底修复一个缺陷",
        "prompt_en": "Something is broken. Here is what I expected, what actually happens, and how to reproduce it:",
        "prompt_zh": "有个功能出了问题。我期望的结果、实际发生的情况以及复现步骤如下：",
    },
    {
        "id": "refactor",
        "title_en": "Refactor safely",
        "title_zh": "安全地重构",
        "prompt_en": "I want to restructure this part of the codebase without changing its behavior:",
        "prompt_zh": "我想在不改变行为的前提下重新整理这部分代码：",
    },
    {
        "id": "add_tests",
        "title_en": "Strengthen test coverage",
        "title_zh": "加强测试覆盖",
        "prompt_en": "I want automated tests that protect these critical behaviors:",
        "prompt_zh": "我希望用自动化测试守护这些关键行为：",
    },
    {
        "id": "web_app",
        "title_en": "Start a small web app",
        "title_zh": "从零搭建一个小型网页应用",
        "prompt_en": "I want to build a small web app. Its main pages and what each one does:",
        "prompt_zh": "我想做一个小型网页应用，主要页面和各自的作用如下：",
    },
)

_SYSTEM_PROMPT = """You are the architecture partner of the Lead Architect of this repository.
Reply in the same language the Lead Architect writes in (Chinese if they write in Chinese,
English if they write in English). Talk with them in plain, warm language: summarise what you
understood, then ask at most two focused questions about whatever is still open (goals, limits,
out-of-scope items, or the exact command that proves the work is done). Keep the formal RFC
section headings below in English so the readiness checker can parse them accurately.

After your reply, include the complete, updated Master RFC inside a fenced block that opens
with ````rfc and closes with ```` (four backticks), so inner ``` code blocks stay intact.
The RFC must start with a "# <title>" line and use exactly these second-level headings, in order:
## Goals              (one summary paragraph, then one "- " bullet per deliverable)
## Constraints        ("- " bullets)
## Non-Goals          ("- " bullets)
## Architecture & Deliverables  ("- " bullets; wrap file paths and modules in `backticks`)
## Verification & Acceptance Criteria  (numbered criteria, then a ```bash block with the
                      verification command once the Lead Architect has named one)
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
    sentences = [s for text in user_turns for s in _sentences(text)]
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
) -> str:
    parts = [_SYSTEM_PROMPT, ""]
    if _prefers_zh(messages, locale):
        parts += ["Respond in natural Chinese (while keeping formal RFC headings in English).", ""]
    if scenario is not None:
        parts += [f"Starting scenario: {scenario['title_en']} - {scenario['prompt_en']}", ""]
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


def _provider_dispatch(cfg: BatonConfig) -> BrainstormDispatch | None:
    """Return a dispatcher for the first ready configured provider, preferring planning roles."""
    from .credentials import probe_role_or_provider

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
) -> BrainstormTurnResult:
    """Run one brainstorm turn and return the reply, a full RFC draft and its Blueprint Card.

    Contract:
    - ``messages`` is the full conversation so far (oldest first) and must end with a ``user``
      message; empty/invalid conversations or an unknown ``scenario`` id -> ``ValueError``.
    - Live path: ``dispatch`` (``prompt -> (provider_id, text)``) when given, otherwise the first
      ready provider of ``cfg`` via ``cli_runner.invoke_provider``. The response must carry a
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
                dispatch = _provider_dispatch(cfg)
            if dispatch is not None:
                provider_used, text = dispatch(_build_prompt(messages, chosen, locale=locale))
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
