"""Guided-mode architecture brainstorm: multi-turn chat -> RFC draft -> Blueprint Card contracts.

Copy rule: every string here talks to the user as the owner of the project, in plain words.
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


ChecklistId = Literal["what", "who", "scope", "limits", "done"]
ChecklistStatus = Literal["clear", "assumed", "open"]
CHECKLIST_IDS: tuple[ChecklistId, ...] = ("what", "who", "scope", "limits", "done")


class ChecklistItem(TypedDict):
    id: ChecklistId
    status: ChecklistStatus
    value: str  # one plain sentence; "" while the item is still open


class BrainstormGuide(TypedDict):
    question: str  # the single question of this turn; "" when nothing is left to ask
    options: list[str]  # 0-4 short clickable answers (the page adds its own "not sure" button)
    checklist: list[ChecklistItem]  # always the five CHECKLIST_IDS, in order


class BrainstormTurnResult(TypedDict):
    reply: str
    rfc_markdown: str
    blueprint: BlueprintCard
    provider_used: str | None  # None when the deterministic offline fallback produced the turn
    offline: bool
    guide: BrainstormGuide
    error: str | None  # short reason when a live turn failed and the offline composer answered


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


def _scenario(scenario_id: str, title_en: str, title_zh: str, prompt_en: str, prompt_zh: str) -> BrainstormScenario:
    return {"id": scenario_id, "title_en": title_en, "title_zh": title_zh, "prompt_en": prompt_en, "prompt_zh": prompt_zh}


# Each prompt is one natural example opener the user can edit.
# Mirrored for the Studio in web/src/components/guided/brainstormScenarios.json (a test keeps them equal).
SCENARIOS: tuple[BrainstormScenario, ...] = (
    _scenario(
        "new_feature", "Ship a new feature", "交付一个新功能",
        "I want to add a button that exports the order list to a spreadsheet file.",
        "我想加一个按钮，把订单列表导出成表格文件。",
    ),
    _scenario(
        "bug_fix", "Fix a bug for good", "彻底修复一个缺陷",
        "The login page goes blank after I enter my password, and I want it fixed for good.",
        "登录页输入密码后就变成空白，我想彻底修好它。",
    ),
    _scenario(
        "refactor", "Refactor safely", "安全地重构",
        "I want to tidy up the messy payment code without changing what it does.",
        "我想把乱糟糟的支付相关代码整理一下，但不改变它的行为。",
    ),
    _scenario(
        "add_tests", "Strengthen test coverage", "加强测试覆盖",
        "I want automated tests that make sure checkout keeps working.",
        "我想加一些自动测试，保证下单流程一直能正常工作。",
    ),
    _scenario(
        "web_app", "Start a small web app", "从零搭建一个小型网页应用",
        "I want a small web page where my team can write down what they did each day.",
        "我想做一个小网页，让团队每天记下自己做了什么。",
    ),
    _scenario(
        "performance", "Make it faster", "优化性能",
        "The search page takes about five seconds to show results, and I want it much faster.",
        "搜索页要等五秒左右才出结果，我想让它快很多。",
    ),
    _scenario(
        "ui_redesign", "Redesign the interface", "界面改版",
        "I want the settings page to look cleaner and be easier to use.",
        "我想让设置页看起来更清爽、用起来更顺手。",
    ),
    _scenario(
        "dependency_upgrade", "Upgrade or migrate a dependency", "升级或迁移依赖",
        "I want to upgrade the main framework this project uses to its latest version.",
        "我想把项目用的主要框架升级到最新版本。",
    ),
    _scenario(
        "write_docs", "Write documentation", "编写文档",
        "I want a short guide that explains how to install and run this project.",
        "我想写一份简短的说明，讲清楚这个项目怎么安装和运行。",
    ),
    _scenario(
        "script_or_data", "Write a script or process data", "写脚本或处理数据",
        "I want a script that merges several spreadsheets into one summary.",
        "我想写个脚本，把几份表格合并成一份汇总。",
    ),
    _scenario(
        "not_sure", "Not sure yet, help me think it through", "还没想清楚，帮我梳理",
        "I have a rough idea but have not worked it out yet, so let us talk it through.",
        "我有个大概的想法，但还没想清楚，想先跟你聊聊。",
    ),
)

_SYSTEM_PROMPT = """You are a friendly planning partner helping the owner of this repository decide what to
build. They may not be a software engineer: use plain words and explain any technical term you need
in a few words, without talking down to them. Reply in the same language they write in (Chinese if
they write in Chinese, English if they write in English). Format your conversational reply in clean
Markdown: short paragraphs, **bold** for key terms, and `backticks` for commands and file paths.

How each turn works:
- Start with one or two sentences that restate what you understood.
- Then ask only one question. It is about the first item of the checklist below that is still
  "open". Do not ask about items that are already clear or assumed.
- If they say they are not sure or ask you to decide, pick a sensible choice yourself, say it in one
  sentence, and mark that item "assumed" so they can change it later.
- If they cannot name a verification command, do not keep asking: propose one yourself that fits
  the project (prefer the detected commands in the project summary), say in one sentence what it
  checks, and put it in the RFC so they can confirm or change it.
- Never invent file paths. Only cite paths that appear in the project summary or that they
  mentioned; otherwise describe the area in words.
- If the request is clearly too big for one build, suggest splitting it into a few steps, write the
  RFC for only the first step, and list the later steps under Non-Goals.

The checklist has exactly five items, always in this order:
"what"   - what to build and the result they want
"who"    - who uses it or is affected by it
"scope"  - how far this build goes and what it leaves out
"limits" - what must not change (files, behaviour, libraries)
"done"   - how we know it is finished (ideally a command that proves it)
Each item has a status: "clear" (they said it), "assumed" (you chose it for them), or "open"
(not discussed yet), plus a "value": one plain sentence, or "" while it is open.

After your reply, include a fenced block that opens with ```guide and closes with ```, holding
only this JSON:
{"question": "<the one question you asked, or \"\" when nothing is left to ask>",
 "options": ["<up to 4 short answers they can click>"],
 "checklist": [{"id": "what", "status": "clear", "value": "..."}, ... all five items in order]}
Do not put an "I am not sure" option in the list; the page always offers one.

Then include the complete, updated Master RFC inside a fenced block that opens with ````rfc and
closes with ```` (four backticks), so inner ``` code blocks stay intact. Keep its section headings
in English exactly as below so the planning tools can read them.
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
_GUIDE_OPEN = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})[ \t]*guide[ \t]*$", re.IGNORECASE)
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
# "Not sure / you decide" replies: the item becomes an assumption, and the reply is not a requirement.
_UNSURE = re.compile(
    r"\b(?:not sure|don'?t know|you decide|up to you|no idea)\b|不确定|不知道|你定|你来定|你帮我定|随便|都行",
    re.IGNORECASE,
)
_GUIDE_VALUE_MAX = 200
_ERROR_MAX = 200
_SECRET_ENV_NAME = re.compile(r"KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL", re.IGNORECASE)
_SECRET_TOKEN = re.compile(r"\b(?:sk|pk|rk|ghp|gho|xox[bp])[-_][A-Za-z0-9_-]{8,}")

# The blueprint's "Change" prefill (web/src/i18n/messages.ts guided.brainstorm.editPrefill and items).
_EDIT_MESSAGE = re.compile(r'^(?:关于「(?P<zh>[^」]+)」，我想改成：|About "(?P<en>[^"]+)", I want to change it to:)(?P<value>.*)$', re.S)
_ITEM_LABELS = {
    "做什么": "what", "给谁用": "who", "做到什么程度": "scope", "不能动什么": "limits", "怎么算完成": "done",
    "What to make": "what", "Who it is for": "who", "How far this round goes": "scope",
    "What must not change": "limits", "How we know it is done": "done",
}

# Asked offline once every item is settled but the blueprint still has no command that proves the work.
_CHECK_QUESTION = {
    "zh": "还差最后一步：做完以后用哪条命令自动检查一遍？点一个最接近的就行，之后还能改。",
    "en": "One last thing: which command should check the work automatically once it is built? "
          "Pick the closest one; you can change it later.",
}
_DEFAULT_CHECK_COMMANDS = ("python -m unittest", "npm test", "pytest")

# Offline questions, one per checklist item ("what" always comes from the first message).
_OFFLINE_QUESTIONS: dict[str, dict[str, tuple[str, tuple[str, ...], str]]] = {
    # id: {lang: (question, options, assumption when the user leaves it to us)}
    "who": {
        "zh": ("这个东西主要给谁用？", ("只有我自己", "我的团队或同事", "外部用户或客户"), "先按只有你自己用来考虑"),
        "en": ("Who will mainly use this?", ("Just me", "My team or coworkers", "Outside users or customers"),
               "Plan it for you alone for now"),
    },
    "scope": {
        "zh": ("这一次先做到什么程度？", ("先做一个最小能用的版本", "一次做完整", "只做核心部分，其余以后再说"),
               "先做一个最小能用的版本"),
        "en": ("How far should this first round go?",
               ("A smallest useful version first", "The complete thing in one go", "Just the core part, the rest later"),
               "Start with a smallest useful version"),
    },
    "limits": {
        "zh": ("有没有不能动的东西？比如不能改的文件、不能加的新依赖。",
               ("不要引入新的依赖", "保持现有功能和用法不变", "没有特别的限制"), "保持现有功能和用法不变"),
        "en": ("Is there anything that must not change, such as files to leave alone or new libraries to avoid?",
               ("Do not add new libraries", "Keep existing behaviour unchanged", "No special limits"),
               "Keep existing behaviour unchanged"),
    },
    "done": {
        "zh": ("做完以后，怎么确认它真的好了？", ("跑一遍项目现有的自动测试", "加上新的自动测试来证明", "我自己打开看一眼就行"),
               "跑一遍项目现有的自动检查"),
        "en": ("Once it is built, how do we check that it really works?",
               ("Run the existing automated tests", "Add new automated tests that prove it", "I will just open it and look"),
               "Run the existing automated checks"),
    },
}


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


class _OfflineParts(TypedDict):
    first: str
    constraints: list[str]
    non_goals: list[str]
    commands: list[str]


def _compose_offline_rfc(
    messages: list[ChatMessage], extra_commands: list[str] | None = None, audience: str | None = None,
) -> tuple[str, _OfflineParts]:
    """Synthesise the RFC from user turns only; also return how the sentences were classified.

    "Not sure / you decide" replies after the first turn are left out: they are not requirements.
    ``audience`` (who it is for) becomes its own line under Goals instead of a bare bullet.
    """
    user_turns = [m["content"].strip() for m in messages if m["role"] == "user" and m["content"].strip()]
    user_turns = user_turns[:1] + [text for text in user_turns[1:] if not _UNSURE.search(text)]
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
    # A clicked "who" option says nothing else, so it lives only on the Audience line; typed answers stay as goals too.
    who_options = {option for langs in _OFFLINE_QUESTIONS["who"].values() for option in langs[1]}
    for sentence in rest:
        if sentence in who_options and sentence == audience:
            continue
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

    for command in extra_commands or []:
        if command not in commands:
            commands.append(command)

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
        *([f"Audience: {audience}", ""] if audience else []),
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
    parts: _OfflineParts = {"first": first, "constraints": constraints, "non_goals": non_goals, "commands": commands}
    return "\n".join(lines), parts


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


def _clip(text: str, limit: int = _GUIDE_VALUE_MAX) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _answers(messages: list[ChatMessage]) -> dict[str, str]:
    """Map checklist ids to the user reply that followed the offline question for that item.

    A "Change" message from the blueprint (``关于「给谁用」，我想改成：…``) updates the named item
    instead of answering the pending question.
    """
    answers: dict[str, str] = {}
    for index, message in enumerate(messages[:-1]):
        reply = messages[index + 1]
        if message["role"] != "assistant" or reply["role"] != "user" or not reply["content"].strip():
            continue
        edit = _EDIT_MESSAGE.match(reply["content"].strip())
        edited = _ITEM_LABELS.get((edit.group("zh") or edit.group("en") or "").strip()) if edit else None
        if edited is not None:
            if edit.group("value").strip():
                answers[edited] = edit.group("value").strip()
            continue
        for item_id, langs in _OFFLINE_QUESTIONS.items():
            if any(langs[lang][0] in message["content"] for lang in ("zh", "en")):
                answers[item_id] = reply["content"].strip()
        if any(question in message["content"] for question in _CHECK_QUESTION.values()):
            answers["check"] = reply["content"].strip()
    return answers


def _offline_checklist(parts: _OfflineParts, answers: dict[str, str], zh: bool) -> list[ChecklistItem]:
    lang = "zh" if zh else "en"
    found = {
        "what": parts["first"],
        "scope": parts["non_goals"][0] if parts["non_goals"] else "",
        "limits": parts["constraints"][0] if parts["constraints"] else "",
        "done": parts["commands"][0] if parts["commands"] else "",
    }
    checklist: list[ChecklistItem] = []
    for item_id in CHECKLIST_IDS:
        answer = answers.get(item_id)
        if answer is not None and _UNSURE.search(answer):
            checklist.append({"id": item_id, "status": "assumed", "value": _OFFLINE_QUESTIONS[item_id][lang][2]})
        elif answer is not None:
            checklist.append({"id": item_id, "status": "clear", "value": _clip(answer)})
        elif found.get(item_id):
            checklist.append({"id": item_id, "status": "clear", "value": _clip(found[item_id])})
        else:
            checklist.append({"id": item_id, "status": "open", "value": ""})
    return checklist


def _project_commands(repo_path: Path) -> list[str]:
    """Bare detected test/build commands of the repository, e.g. ``npm run test``."""
    repo = Path(repo_path)
    try:
        folders = [e for e in repo.iterdir() if e.is_dir() and e.name not in _CONTEXT_SKIP_DIRS]
    except OSError:
        folders = []
    return [command.split("  (")[0] for command in _detected_commands(repo, sorted(folders))]


def _project_check_commands(repo_path: Path) -> list[str]:
    """Project commands the readiness checker recognises, test commands first."""
    commands = [c for c in _project_commands(repo_path) if check_rfc_readiness(c)["detected_commands"]]
    return [c for c in commands if "test" in c] + [c for c in commands if "test" not in c]


def _check_command_options(repo_path: Path) -> list[str]:
    """2-4 clickable verification commands: the project's own first, then common defaults."""
    return list(dict.fromkeys([*_project_check_commands(repo_path)[:2], *_DEFAULT_CHECK_COMMANDS]))[:4]


def _offline_turn(
    repo_path: Path,
    messages: list[ChatMessage],
    scenario: BrainstormScenario | None,
    *,
    zh: bool,
) -> tuple[str, str, BrainstormGuide]:
    """Deterministic offline turn: ``(reply, rfc_markdown, guide)`` asking about the first open item."""
    lang = "zh" if zh else "en"
    answers = _answers(messages)
    check = answers.pop("check", None)
    check_unsure = check is not None and bool(_UNSURE.search(check))
    if check is not None and not check_unsure:
        answers["done"] = check  # the command they picked or typed
    who = answers.get("who")
    audience = None if who is None else (
        f"{_OFFLINE_QUESTIONS['who'][lang][2]} (assumed)" if _UNSURE.search(who) else who
    )
    extra: list[str] = []
    if check_unsure:
        extra = _check_command_options(repo_path)[:1]  # they left it to us: take the first offered command
    elif "done" in answers:
        # They answered how to check the work; use the project's own test command when it has one.
        extra = _project_check_commands(repo_path)[:1]
    rfc_markdown, parts = _compose_offline_rfc(messages, None, audience)
    if extra and not parts["commands"]:
        rfc_markdown, parts = _compose_offline_rfc(messages, extra, audience)
    checklist = _offline_checklist(parts, answers, zh)
    if check_unsure and extra:
        checklist = [
            {"id": "done", "status": "assumed", "value": extra[0]} if item["id"] == "done" else item
            for item in checklist
        ]
    ready = check_rfc_readiness(rfc_markdown)["safe_for_overnight"]
    next_open = next((item["id"] for item in checklist if item["status"] == "open"), None)
    if next_open is not None:
        question, options = _OFFLINE_QUESTIONS[next_open][lang][0], list(_OFFLINE_QUESTIONS[next_open][lang][1])
    elif not ready and not parts["commands"]:
        # Every item is settled, but nothing can prove the work yet: ask for the command instead of claiming ready.
        question, options = _CHECK_QUESTION[lang], _check_command_options(repo_path)
    else:
        question, options = "", []

    title = rfc_markdown.splitlines()[0][2:].strip()
    follow_up = any(message["role"] == "assistant" for message in messages)
    if zh:
        lead = f"从「{scenario['title_zh']}」出发，" if scenario else ""
        reply = "好的，记下了，蓝图已更新。" if follow_up else f"{lead}我把你的想法记进了蓝图：「{title}」。"
        closing = "该问的都问完了。看看右边的蓝图，没问题就可以开工了。" if ready else "该问的都问完了，看看右边的蓝图还差什么。"
    else:
        lead = f'Starting from "{scenario["title_en"]}", ' if scenario else ""
        reply = "Got it, the blueprint is updated." if follow_up else f'{lead}I added your idea to the blueprint: "{title}".'
        closing = (
            "That covers everything I wanted to ask. Check the blueprint on the right, and start building when it reads right."
            if ready else "That covers everything I wanted to ask. The blueprint on the right shows what is still missing."
        )
    reply += f"\n\n{question or closing}"
    return reply, rfc_markdown, {"question": question, "options": options, "checklist": checklist}


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
        speaker = "User" if message["role"] == "user" else "You"
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


def _extract_guide_block(text: str) -> tuple[str, str | None]:
    """Return ``(text without the guide block, guide block body or None)``."""
    lines = text.replace("\r\n", "\n").split("\n")
    start = next((i for i, line in enumerate(lines) if _GUIDE_OPEN.match(line)), None)
    if start is None:
        return text, None
    opener = _GUIDE_OPEN.match(lines[start]).group(1)
    for end in range(start + 1, len(lines)):
        match = _FENCE_LINE.match(lines[end])
        if match and match.group(1)[0] == opener[0] and len(match.group(1)) >= len(opener) and not match.group(2).strip():
            return "\n".join([*lines[:start], *lines[end + 1:]]), "\n".join(lines[start + 1:end])
    return "\n".join([*lines[:start], *lines[start + 1:]]), None  # unclosed: drop only the fence line


def _parse_guide(raw: str | None) -> BrainstormGuide | None:
    """Validate a live guide block; ``None`` when it is missing or not a JSON object."""
    if raw is None:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    question = data.get("question")
    options = data.get("options") if isinstance(data.get("options"), list) else []
    entries: dict[str, dict] = {}
    for entry in data.get("checklist") if isinstance(data.get("checklist"), list) else []:
        if isinstance(entry, dict) and entry.get("id") in CHECKLIST_IDS and entry["id"] not in entries:
            entries[entry["id"]] = entry
    checklist: list[ChecklistItem] = []
    for item_id in CHECKLIST_IDS:
        entry = entries.get(item_id, {})
        status = entry.get("status") if entry.get("status") in ("clear", "assumed") else "open"
        value = _clip(entry["value"]) if isinstance(entry.get("value"), str) else ""
        if status == "open" or not value:
            status, value = "open", ""
        checklist.append({"id": item_id, "status": status, "value": value})
    clean_options = [
        _clip(option, 80) for option in options
        if isinstance(option, str) and option.strip() and not _UNSURE.search(option)
    ]
    return {
        "question": _clip(question, 300) if isinstance(question, str) else "",
        "options": clean_options[:4],
        "checklist": checklist,
    }


def _guide_from_rfc(rfc_markdown: str) -> BrainstormGuide:
    """Fallback guide when a live reply has no usable guide block: items with real RFC content are clear."""
    sections = _section_lines(rfc_markdown)

    def first_bullet(name: str) -> str:
        for line in sections.get(name.lower(), []):
            bullet = _BULLET.match(line)
            if bullet:
                return bullet.group("text").strip()
        return ""

    commands = check_rfc_readiness(rfc_markdown)["detected_commands"]
    title = next((line[2:].strip() for line in rfc_markdown.splitlines() if line.startswith("# ")), "")
    found = {
        "what": title or first_bullet("Goals"),
        "who": "",
        "scope": first_bullet("Non-Goals"),
        "limits": first_bullet("Constraints"),
        "done": commands[0] if commands else "",
    }
    checklist: list[ChecklistItem] = [
        {"id": item_id, "status": "clear", "value": _clip(found[item_id])} if found[item_id]
        else {"id": item_id, "status": "open", "value": ""}
        for item_id in CHECKLIST_IDS
    ]
    return {"question": "", "options": [], "checklist": checklist}


def _safe_error(exc: BaseException) -> str:
    """A short, single-line reason for a live failure, with secret values masked."""
    text = str(exc).strip() or type(exc).__name__
    for name, value in os.environ.items():
        if _SECRET_ENV_NAME.search(name) and len(value) >= 6:
            text = text.replace(value, "***")
    text = _SECRET_TOKEN.sub("***", text)
    return _clip(text, _ERROR_MAX)


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
      A fenced ``guide`` block (question, options, checklist) is parsed and removed from ``reply``;
      when it is missing or invalid, ``guide`` is derived from the RFC with an empty question.
    - Offline path: env ``VIBEBATON_OFFLINE_BRAINSTORM=1`` (or ``VIBEBATON_BRAINSTORM_OFFLINE=1``),
      no dispatcher and no ready provider, or any live failure uses the deterministic offline
      composer: same input -> same output, ``offline=True``, ``provider_used=None``. It asks about
      the first open checklist item with fixed bilingual options.
    - ``error`` is ``None`` except after a live failure, where it is a short reason (<= 200 chars,
      secret values masked) and the offline result is returned alongside it.
    - ``rfc_markdown`` always starts with ``"# "`` and has ``## Goals``, ``## Constraints``,
      ``## Non-Goals``, ``## Architecture & Deliverables`` and ``## Verification & Acceptance
      Criteria`` headings. ``blueprint.readiness_score`` equals its readiness score and
      ``ready_to_launch`` equals its ``safe_for_overnight``.
    - Never writes to the repository; ``confirm_blueprint`` persists the draft.
    """
    chosen = _validate(messages, scenario)
    error: str | None = None
    if not _offline_requested():
        try:
            if dispatch is None and cfg is not None:
                dispatch = _provider_dispatch(cfg, model_overrides)
            if dispatch is not None:
                prompt = _build_prompt(messages, chosen, locale=locale, project=project_context(repo_path))
                provider_used, text = dispatch(prompt)
                text, guide_block = _extract_guide_block(text)
                reply, rfc_markdown = _split_live_response(text)
                return {
                    "reply": reply,
                    "rfc_markdown": rfc_markdown,
                    "blueprint": _blueprint(rfc_markdown),
                    "provider_used": provider_used,
                    "offline": False,
                    "guide": _parse_guide(guide_block) or _guide_from_rfc(rfc_markdown),
                    "error": None,
                }
        except Exception as exc:  # noqa: BLE001 - any live failure degrades to the offline composer, visibly
            error = _safe_error(exc)

    reply, rfc_markdown, guide = _offline_turn(repo_path, messages, chosen, zh=_prefers_zh(messages, locale))
    return {
        "reply": reply,
        "rfc_markdown": rfc_markdown,
        "blueprint": _blueprint(rfc_markdown),
        "provider_used": None,
        "offline": True,
        "guide": guide,
        "error": error,
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
