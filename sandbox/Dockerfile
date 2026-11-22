# syntax=docker/dockerfile:1
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
