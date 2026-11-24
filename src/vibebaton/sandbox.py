"""Generate VibeBaton's Docker Compose and Dev Container scaffolding."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

SANDBOX_TEMPLATES: dict[str, str] = {
    ".devcontainer/devcontainer.json": """{
  "name": "VibeBaton Sandbox",
  "build": {
    "dockerfile": "../sandbox/Dockerfile",
    "context": "../sandbox"
  },
  "remoteUser": "baton",
  "updateRemoteUserUID": false,
  "workspaceMount": "source=${localWorkspaceFolder},target=/workspace,type=bind",
  "workspaceFolder": "/workspace",
  "postCreateCommand": ["python", "-P", "-m", "vibebaton", "--help"],
  "runArgs": ["--cap-drop=ALL", "--security-opt=no-new-privileges:true"]
}
""",
    "sandbox/Dockerfile": r"""# syntax=docker/dockerfile:1
FROM python:3.12-slim

# The NodeSource Node.js 24 LTS package includes npm.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        -o /usr/share/keyrings/nodesource.asc \
    && printf '%s\n' \
        'deb [signed-by=/usr/share/keyrings/nodesource.asc] https://deb.nodesource.com/node_24.x nodistro main' \
        > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install the VibeBaton runtime exported by the scaffolding command.
RUN --mount=type=bind,source=vibebaton-runtime.zip,target=/tmp/vibebaton-runtime.zip \
    python -m zipfile -e /tmp/vibebaton-runtime.zip /opt/vibebaton \
    && printf '%s\n' '#!/bin/sh' 'exec python -P -m vibebaton "$@"' > /usr/local/bin/baton \
    && chmod 755 /usr/local/bin/baton

RUN groupadd --gid 1000 baton \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash baton \
    && install -d -o baton -g baton /workspace

WORKDIR /workspace
ENV PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 PYTHONPATH=/opt/vibebaton/src
USER baton

CMD ["python", "-P", "-m", "vibebaton", "--help"]
""",
    "sandbox/docker-compose.yml": """services:
  vibebaton:
    build:
      context: .
      dockerfile: Dockerfile
    user: "1000:1000"
    working_dir: /workspace
    volumes:
      - ..:/workspace:rw
      - "${VIBEBATON_CREDENTIALS_DIR:-../.vibebaton-empty}:/home/baton/.vibebaton:ro"
    environment:
      - OPENAI_API_KEY=${OPENAI_API_KEY:-}
      - DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:-}
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    read_only: true
    tmpfs: [/tmp, /home/baton/.cache]
    pids_limit: 256
    mem_limit: 2g
""",
    "sandbox/.dockerignore": "**\n!vibebaton-runtime.zip\n",
    ".vibebaton-empty/.gitkeep": "",
}

_RUNTIME_ARCHIVE = "sandbox/vibebaton-runtime.zip"
SANDBOX_FILES = (*SANDBOX_TEMPLATES, _RUNTIME_ARCHIVE)


def _runtime_archive() -> bytes:
    """Snapshot the running VibeBaton package and its bundled CLI resources."""
    package = Path(__file__).resolve().parent
    root = package.parents[1]
    payload = BytesIO()
    with ZipFile(payload, "w", ZIP_DEFLATED, strict_timestamps=False) as archive:
        for path in sorted(package.rglob("*.py")):
            name = path.relative_to(package).as_posix()
            archive.write(path, f"src/vibebaton/{name}")
        for pattern in ("baton.example.toml", "LICENSE", "prompts/*.md", "presets/*.baton.json", "presets/*.patch.yml"):
            for path in sorted(root.glob(pattern)):
                archive.write(path, path.relative_to(root).as_posix())
    return payload.getvalue()


def init_sandbox_files(repo_dir: Path, force: bool = False) -> list[Path]:
    """Write sandbox scaffolding and return the resolved paths written in registry order.

    Existing files are preserved unless force is true. A template path that
    resolves outside the repository raises ValueError before any write.
    """
    repo_dir = repo_dir.resolve()
    targets: list[tuple[str, Path]] = []
    for rel in (*SANDBOX_TEMPLATES, _RUNTIME_ARCHIVE):
        target = (repo_dir / rel).resolve()
        if repo_dir not in target.parents:
            raise ValueError(f"Sandbox template path is outside the repository: {rel}")
        targets.append((rel, target))

    written: list[Path] = []
    mode = "wb" if force else "xb"
    for rel, target in targets:
        if not force and target.exists():
            continue
        content = (
            _runtime_archive()
            if rel == _RUNTIME_ARCHIVE
            else SANDBOX_TEMPLATES[rel].encode("utf-8")
        )
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            with target.open(mode) as template_file:
                template_file.write(content)
        except FileExistsError:
            if force:
                raise
            continue
        written.append(target)
    return written


def sandbox_file_status(repo_dir: Path) -> dict[str, bool]:
    """Report which sandbox template paths resolve to files inside the repository."""
    repo_dir = repo_dir.resolve()
    status: dict[str, bool] = {}
    for rel in SANDBOX_FILES:
        target = (repo_dir / rel).resolve()
        status[rel] = repo_dir in target.parents and target.is_file()
    return status
