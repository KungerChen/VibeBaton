"""Regenerate python_parity.json using the Python engine in this worktree.

Run from the repository root:
    python web/src/engine/__fixtures__/generate_python_parity.py
"""

import json
import sys
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent
ROOT = FIXTURES.parents[3]
sys.path.insert(0, str(ROOT / "src"))

from vibebaton.graph_engine import SCENARIOS, simulate_graph
from vibebaton.graph_schema import WorkflowGraph


def main() -> None:
    graphs = {}
    for path in sorted((ROOT / "presets").glob("*.baton.json")):
        graph = json.loads(path.read_text(encoding="utf-8"))
        graphs[graph["id"]] = graph
    graphs.update(json.loads((FIXTURES / "custom_graphs.json").read_text(encoding="utf-8")))

    fixture = {}
    for graph_id, data in graphs.items():
        graph = WorkflowGraph.from_dict(data)
        fixture[graph_id] = {}
        for scenario in SCENARIOS:
            result = simulate_graph(graph, scenario)
            fixture[graph_id][scenario] = {
                "status": result.status,
                "visited_nodes": result.visited_nodes,
            }

    (FIXTURES / "python_parity.json").write_text(
        json.dumps(fixture, indent=2) + "\n", encoding="utf-8", newline="\n"
    )


if __name__ == "__main__":
    main()
