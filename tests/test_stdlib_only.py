"""Regression: the vibebaton package must have zero static non-stdlib imports."""

from __future__ import annotations

import ast
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from vibebaton import config

PKG_DIR = Path(__file__).resolve().parent.parent / "src" / "vibebaton"


def _third_party_imports() -> list[tuple[str, int, str]]:
    std = set(sys.stdlib_module_names)
    bad: list[tuple[str, int, str]] = []
    for path in sorted(PKG_DIR.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0:
                names = [node.module or ""]
            else:
                continue
            for name in names:
                top = name.split(".")[0]
                if top and top not in std and top != "vibebaton":
                    bad.append((path.name, node.lineno, name))
    return bad


class StdlibOnlyImportsTest(unittest.TestCase):
    def test_no_static_third_party_imports(self) -> None:
        self.assertEqual(_third_party_imports(), [])

    def test_yaml_config_without_pyyaml_raises_clear_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.yaml"
            path.write_text("a: 1\n", encoding="utf-8")
            with mock.patch.dict(sys.modules, {"yaml": None}):
                with self.assertRaisesRegex(RuntimeError, "PyYAML is not installed"):
                    config._load_raw_mapping(path)


if __name__ == "__main__":
    unittest.main()
