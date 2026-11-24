"""Load and validate workflow presets from the repository ``presets/`` folder.

Every preset is a ``*.baton.json`` document accepted by
``WorkflowGraph.from_dict``. ``presets_dir`` finds the repository ``presets/``
folder beside the package and falls back to ``presets/`` under the current
working directory. ``list_presets`` summarizes the matching files sorted by
filename, ``load_preset`` resolves a preset by id, filename, or existing path,
and ``validate_all_presets`` validates every preset keyed by its id. Files are
read as UTF-8; non-matching files such as ``.patch.yml`` are ignored.

    >>> from vibebaton.presets import list_presets
    >>> summaries = list_presets()
    >>> len(summaries) >= 3 and all(summary.node_count > 0 for summary in summaries)
    True
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, NoReturn

from vibebaton.graph_schema import GraphValidationResult, WorkflowGraph, validate_graph

PRESET_SUFFIX = ".baton.json"


@dataclass
class PresetSummary:
    """Preset metadata with defaults for graphs that omit it.

    The default category is ``audit`` for ``review_only_audit``, ``panel`` for
    ``specialist_panel``, ``small_project``
    for other beginner graphs, and ``general`` otherwise. Provider requirements
    default to distinct nonempty provider IDs in node order, excluding
    ``host_native``. The default cost tier is ``medium`` and the default
    attribution is ``None``. Explicit metadata takes precedence, including an
    empty provider list.
    """

    id: str
    name: str
    difficulty: str
    description: str
    recommended_for: list[str]
    path: str
    node_count: int
    edge_count: int
    category: str
    required_providers: list[str]
    cost_tier: str
    inspired_by: str | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def presets_dir() -> Path:
    """Return the repository ``presets/`` directory, falling back to the working directory."""
    package_presets = Path(__file__).resolve().parents[2] / "presets"
    if package_presets.is_dir():
        return package_presets
    return Path.cwd() / "presets"


def list_presets(directory: str | Path | None = None) -> list[PresetSummary]:
    """Summarize every ``*.baton.json`` preset, sorted by filename."""
    summaries: list[PresetSummary] = []
    for path in _preset_paths(directory):
        graph = _load_graph(path)
        summaries.append(
            PresetSummary(
                id=graph.id,
                name=graph.name,
                difficulty=graph.difficulty,
                description=graph.description,
                recommended_for=graph.recommended_for,
                path=str(path),
                node_count=len(graph.nodes),
                edge_count=len(graph.edges),
                category=graph.category if graph.category is not None else _default_category(graph),
                required_providers=(
                    graph.required_providers
                    if graph.required_providers is not None
                    else _providers_from_nodes(graph)
                ),
                cost_tier=graph.cost_tier if graph.cost_tier is not None else "medium",
                inspired_by=graph.inspired_by,
            )
        )
    return summaries


def load_preset(id_or_path: str | Path, directory: str | Path | None = None) -> WorkflowGraph:
    """Load a preset by id, filename, or an existing path to a ``.baton.json`` file."""
    source = Path(id_or_path)
    target = Path(directory) if directory is not None else presets_dir()

    if _is_explicit_path(source):
        if source.is_file():
            return _load_graph(source)
        _raise_preset_not_found(id_or_path, target)

    filename = source.name
    if not filename.endswith(PRESET_SUFFIX):
        filename += PRESET_SUFFIX
    candidate = target / filename
    if candidate.is_file():
        return _load_graph(candidate)

    # Only a bare *.baton.json filename may fall back to the working directory.
    if source.name.endswith(PRESET_SUFFIX) and source.is_file():
        return _load_graph(source)

    presets = list_presets(target)
    for summary in presets:
        if summary.id == source.name:
            return _load_graph(Path(summary.path))

    _raise_preset_not_found(id_or_path, target, presets)


def validate_all_presets(
    directory: str | Path | None = None,
) -> dict[str, GraphValidationResult]:
    """Validate every preset in the directory, keyed by preset id."""
    results: dict[str, GraphValidationResult] = {}
    for path in _preset_paths(directory):
        graph = _load_graph(path)
        results[graph.id] = validate_graph(graph)
    return results


def _default_category(graph: WorkflowGraph) -> str:
    if graph.id == "review_only_audit":
        return "audit"
    if graph.id == "specialist_panel":
        return "panel"
    return "small_project" if graph.difficulty == "beginner" else "general"


def _providers_from_nodes(graph: WorkflowGraph) -> list[str]:
    providers = (node.config.get("provider") for node in graph.nodes)
    return list(dict.fromkeys(
        provider for provider in providers
        if isinstance(provider, str) and provider and provider != "host_native"
    ))


def _preset_paths(directory: str | Path | None = None) -> list[Path]:
    target = Path(directory) if directory is not None else presets_dir()
    return sorted(
        (path for path in target.glob(f"*{PRESET_SUFFIX}") if path.is_file()),
        key=lambda path: path.name,
    )


def _is_explicit_path(source: Path) -> bool:
    """Return True when the caller supplied a directory component, not a bare name."""
    return source.is_absolute() or len(source.parts) > 1


def _raise_preset_not_found(
    id_or_path: str | Path,
    target: Path,
    presets: list[PresetSummary] | None = None,
) -> NoReturn:
    if presets is None:
        presets = list_presets(target)
    known_ids = ", ".join(summary.id for summary in presets) or "none"
    raise FileNotFoundError(
        f"Preset {str(id_or_path)!r} not found in {target}. Known preset ids: {known_ids}"
    )


def _load_graph(path: Path) -> WorkflowGraph:
    return WorkflowGraph.from_dict(json.loads(path.read_text(encoding="utf-8")))
