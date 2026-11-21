"""Allow invoking VibeBaton via `python -m vibebaton`."""

from .cli import main

if __name__ == "__main__":
    raise SystemExit(main())
