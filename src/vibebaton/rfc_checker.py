"""Deterministic RFC readiness scoring and structured RFC synthesis."""

from __future__ import annotations

import json
import re
from typing import TypedDict

_SECTION_ORDER = ("goal", "constraints", "acceptance")
_SECTION_WEIGHTS = {"goal": 30, "constraints": 25, "acceptance": 25}
_COMMAND_WEIGHT = 20

_SECTION_PATTERNS = {
    "goal": re.compile(r"^(?:(?:goals?|objectives?)\b|目标)", re.IGNORECASE),
    "constraints": re.compile(
        r"^(?:(?:(?:hard )?constraints?|non[\s-]?goals?|out[\s-]?of[\s-]?scope)\b|约束)",
        re.IGNORECASE,
    ),
    "acceptance": re.compile(r"^(?:(?:acceptance|verification|tests?|testing)\b|验收)", re.IGNORECASE),
}

_HEADING_RE = re.compile(r"^[ \t]{0,3}#{1,6}[ \t]*(?P<label>\S.*?)[ \t]*$")
_BOLD_RE = re.compile(
    r"^[ \t]{0,3}(?:[-*+][ \t]+)?(?:\*\*|__)(?P<label>[^*_\n]+?)(?:\*\*|__)(?P<rest>.*)$",
)
_FENCE_RE = re.compile(r"^(?P<fence>`{3,}|~{3,})(?P<rest>.*)$")

_AMBIGUITY_PATTERNS = {
    "TBD": re.compile(r"\bTBD\b", re.IGNORECASE),
    "TODO": re.compile(r"\bTODO\b", re.IGNORECASE),
    "etc.": re.compile(r"\betc\.", re.IGNORECASE),
    "maybe": re.compile(r"\bmaybe\b", re.IGNORECASE),
}

_NPM_OPTION = (
    r"--?[A-Za-z][\w-]*(?:[ \t]*=[ \t]*[^\s-][^\s]*|[ \t]+[^\s-][^\s]*)?"
)
_NPM_LEAD = rf"\bnpm(?:[ \t]+{_NPM_OPTION})*[ \t]+"

_COMMAND_PATTERNS = (
    ("python -m unittest", re.compile(r"\bpython(?:3(?:\.\d+)?)?\s+-m\s+unittest\b", re.IGNORECASE)),
    ("npm test", re.compile(_NPM_LEAD + r"(?:(?:run[ \t]+)?test|t)\b", re.IGNORECASE)),
    ("npm run", re.compile(_NPM_LEAD + r"run\b", re.IGNORECASE)),
    ("cargo test", re.compile(r"\bcargo\s+test\b", re.IGNORECASE)),
    ("go test", re.compile(r"\bgo\s+test\b", re.IGNORECASE)),
    ("make test", re.compile(r"\bmake\s+test\b", re.IGNORECASE)),
    ("dotnet test", re.compile(r"\bdotnet\s+test\b", re.IGNORECASE)),
    ("pytest", re.compile(r"\bpytest\b", re.IGNORECASE)),
    ("unittest", re.compile(r"\bunittest\b", re.IGNORECASE)),
    ("vitest", re.compile(r"\bvitest\b", re.IGNORECASE)),
    ("npx", re.compile(r"\bnpx\b", re.IGNORECASE)),
    ("mvn", re.compile(r"\bmvnw?\b", re.IGNORECASE)),
    ("gradle", re.compile(r"\bgradlew?\b", re.IGNORECASE)),
)

_NUMBERED_ITEM = re.compile(r"^[ \t]*\d+[.)][ \t]*\S")

_SHELL_LANGUAGES = frozenset({
    "bash", "bat", "batch", "cmd", "console", "fish", "powershell", "ps1", "pwsh",
    "sh", "shell", "zsh",
})
_DATA_LANGUAGES = frozenset({"json", "json5", "jsonc", "jsonl", "ndjson"})
_PLAIN_LANGUAGES = frozenset({"", "output", "plaintext", "text", "txt"})


class RFCReadiness(TypedDict):
    score: int
    safe_for_overnight: bool
    missing_sections: list[str]
    warnings: list[str]
    detected_commands: list[str]


class GeneratedRFC(TypedDict):
    rfc_markdown: str
    readiness: RFCReadiness


def _clean_label(label: str) -> str:
    label = label.strip().strip("*_`").strip().rstrip("#").strip()
    label = re.sub(r"^\d+[.)]\s+", "", label)
    label = re.sub(r"\s+", " ", label)
    return label.rstrip(":：").strip()


def _match_section(label: str) -> str | None:
    for section in _SECTION_ORDER:
        if _SECTION_PATTERNS[section].match(label):
            return section
    return None


def _fence_parts(line: str) -> tuple[str, int, str] | None:
    match = _FENCE_RE.match(line.lstrip(" \t"))
    if match is None:
        return None
    fence = match.group("fence")
    return fence[0], len(fence), match.group("rest")


def _opening_fence(line: str) -> tuple[str, int, str] | None:
    parts = _fence_parts(line)
    if parts is None:
        return None
    marker, length, rest = parts
    if marker == "`" and "`" in rest:
        return None
    info = rest.strip()
    language = info.split()[0].strip("{}").lstrip(".").lower() if info else ""
    return marker, length, language


def _closes_fence(line: str, opener: tuple[str, int, str]) -> bool:
    parts = _fence_parts(line)
    if parts is None:
        return False
    marker, length, rest = parts
    return marker == opener[0] and length >= opener[1] and not rest.strip()


def _label_tail(label: str, section: str) -> str:
    match = _SECTION_PATTERNS[section].match(label)
    if match is None:
        return ""
    tail = label[match.end():].lstrip()
    if not tail or tail[0] not in ":：-—–":
        return ""
    return tail.strip(" \t:：-—–")


def _parse_heading(line: str) -> tuple[str, str | None, str] | None:
    heading = _HEADING_RE.match(line)
    if heading is not None:
        label = _clean_label(heading.group("label"))
        section = _match_section(label)
        return label, section, _label_tail(label, section) if section else ""

    bold = _BOLD_RE.match(line)
    if bold is None:
        return None
    label = _clean_label(bold.group("label"))
    section = _match_section(label)
    if section is None:
        return None
    rest = bold.group("rest").strip(" \t:：-—–")
    inline_body = " ".join(part for part in (_label_tail(label, section), rest) if part)
    return label, section, inline_body


def _logical_commands(lines: list[str]) -> list[str]:
    commands: list[str] = []
    pending = ""
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        pending = f"{pending} {stripped}" if pending else stripped
        if pending.endswith("\\"):
            pending = pending[:-1].rstrip()
            continue
        commands.append(pending)
        pending = ""
    if pending:
        commands.append(pending)
    return commands


def _looks_like_json(lines: list[str]) -> bool:
    text = "\n".join(lines).strip()
    if not text or text[0] not in "[{":
        return False
    try:
        json.loads(text)
    except (ValueError, RecursionError):
        return False
    return True


def _is_data_block(language: str, lines: list[str]) -> bool:
    if language in _DATA_LANGUAGES or language.startswith("json"):
        return True
    if language in _SHELL_LANGUAGES:
        return False
    return language in _PLAIN_LANGUAGES and _looks_like_json(lines)


def _detect_commands(text: str) -> list[str]:
    matches: list[tuple[int, int, str]] = []
    for name, pattern in _COMMAND_PATTERNS:
        for match in pattern.finditer(text):
            matches.append((match.start(), match.end(), name))
    matches.sort(key=lambda match: (match[0], -(match[1] - match[0])))

    detected: list[str] = []
    covered_until = -1
    for start, end, name in matches:
        if start < covered_until:
            continue
        if name not in detected:
            detected.append(name)
        covered_until = end
    return detected


def _commands_in_block(language: str, block: list[str], *, allow_custom: bool) -> list[str]:
    if _is_data_block(language, block):
        return []
    is_shell = language in _SHELL_LANGUAGES
    if is_shell:
        lines = _logical_commands(block)
    else:
        lines = [line.strip() for line in block if line.strip()]
    commands: list[str] = []
    for line in lines:
        names = _detect_commands(line)
        if not names and allow_custom and (is_shell or len(lines) == 1):
            names = [line]
        commands.extend(names)
    return commands


def _parse_document(text: str) -> tuple[dict[str, list[str]], list[str], list[str]]:
    sections: dict[str, list[str]] = {}
    headings: list[str] = []
    commands: list[str] = []
    section: str | None = None
    fence: tuple[str, int, str] | None = None
    block: list[str] = []

    for line in text.splitlines():
        if fence is not None:
            if _closes_fence(line, fence):
                commands.extend(_commands_in_block(
                    fence[2], block, allow_custom=section == "acceptance",
                ))
                fence = None
            else:
                block.append(line)
            continue

        fence = _opening_fence(line)
        if fence is not None:
            block = []
            continue

        commands.extend(_detect_commands(line))
        heading = _parse_heading(line)
        if heading is not None:
            label, section, inline_body = heading
            headings.append(label)
            if section is not None:
                sections.setdefault(section, []).append(inline_body)
        elif section is not None:
            sections[section].append(line)

    if fence is not None:
        commands.extend(_commands_in_block(fence[2], block, allow_custom=False))
    return sections, headings, list(dict.fromkeys(commands))


def check_rfc_readiness(rfc_text: str) -> RFCReadiness:
    """Score required sections and verification commands found throughout the RFC."""
    sections, headings, detected_commands = _parse_document(rfc_text)
    missing_sections = [section for section in _SECTION_ORDER if section not in sections]

    warnings: list[str] = []
    for marker, pattern in _AMBIGUITY_PATTERNS.items():
        if pattern.search(rfc_text):
            warnings.append(f"Ambiguity marker {marker!r} found.")
    if any("?" in heading for heading in headings):
        warnings.append("Question mark found in a heading.")

    if "goal" in sections:
        goal_text = " ".join(" ".join(sections["goal"]).split())
        if len(goal_text) < 40:
            warnings.append("Goal is shorter than 40 characters.")
    if "acceptance" in sections and not any(
        _NUMBERED_ITEM.match(line) for line in sections["acceptance"]
    ):
        warnings.append("Acceptance criteria are not numbered.")

    score = sum(_SECTION_WEIGHTS[section] for section in sections)
    if detected_commands:
        score += _COMMAND_WEIGHT
    score = max(0, score - 5 * len(warnings))
    safe_for_overnight = score >= 70 and not missing_sections and bool(detected_commands)

    return {
        "score": score,
        "safe_for_overnight": safe_for_overnight,
        "missing_sections": missing_sections,
        "warnings": warnings,
        "detected_commands": detected_commands,
    }


def generate_structured_rfc(
    goal: str,
    constraints: str = "",
    acceptance_cmd: str = "",
    non_goals: str = "",
) -> GeneratedRFC:
    """Build a sectioned RFC and return its deterministic readiness report."""
    command = acceptance_cmd.strip()
    if command:
        backtick_runs = re.findall(r"`{3,}", command)
        fence = "`" * (max(map(len, backtick_runs), default=2) + 1)
        acceptance = (
            "1. The verification command exits successfully.\n\n"
            f"{fence}bash\n{command}\n{fence}"
        )
    else:
        acceptance = "TODO: add numbered acceptance criteria and a concrete verification command."
    rfc_markdown = "\n".join((
        "# RFC",
        "",
        "## Goal",
        "",
        goal.strip(),
        "",
        "## Constraints",
        "",
        constraints.strip(),
        "",
        "## Non-goals",
        "",
        non_goals.strip(),
        "",
        "## Acceptance Criteria",
        "",
        acceptance,
        "",
    ))
    return {"rfc_markdown": rfc_markdown, "readiness": check_rfc_readiness(rfc_markdown)}
