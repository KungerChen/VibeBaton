"""Load the adapter package from the selected benchmark repository."""

import os
import sys
from importlib import import_module
from pathlib import Path
from types import ModuleType

TARGET_ENV = "VIBEBATON_BENCH_TARGET"
DEFAULT_TARGET = Path(__file__).resolve().parents[1] / "reference_solution"


def load_target() -> ModuleType:
    """Import top-level adapters from the target root for this process."""
    target = Path(os.environ.get(TARGET_ENV, str(DEFAULT_TARGET))).resolve()
    package_init = target / "adapters" / "__init__.py"
    if not package_init.is_file():
        raise ImportError(f"{TARGET_ENV} must point to a repo with adapters/__init__.py: {target}")

    adapters = sys.modules.get("adapters")
    if adapters is None:
        if not sys.path or sys.path[0] != str(target):
            sys.path.insert(0, str(target))
        adapters = import_module("adapters")

    origin = getattr(adapters, "__file__", None)
    if origin is None or Path(origin).resolve() != package_init.resolve():
        raise ImportError(
            f"Expected adapters at {package_init}, loaded {origin}. "
            "Use a fresh Python process for each benchmark target."
        )
    return adapters
