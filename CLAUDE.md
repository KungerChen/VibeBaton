# VibeBaton project guide

Use [README.md](README.md) to run the project, [.baton/00_RFC.md](.baton/00_RFC.md) for the release requirements, and [LOG-INDEX.md](LOG-INDEX.md) for verification records.

## Project structure

```text
.devcontainer/                  Dev Container configuration
docs/                           Release notes, roadmap, security guide, and tutorial
presets/                        Workflow graphs shared by the CLI and Studio
sandbox/                        Dockerfile and Compose template
scripts/                        Windows installer
src/vibebaton/                  Python package and CLI
  engine.py                     Task orchestration and mechanical gates
  http_provider.py              OpenAI-compatible HTTP transport and usage accounting
  report.py                     Run telemetry and battle reports
  sandbox.py                    Sandbox template and runtime bundle generation
  web_server.py                 Studio HTTP and SSE APIs and static bundle hosting
tests/                          Python contracts and integration tests
web/                            React Studio, Vitest suites, and Vite build
```
