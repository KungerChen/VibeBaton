# VibeBaton 施工日志

此前的施工记录见 [.baton/LOG.md](.baton/LOG.md)。根目录记录由 [LOG-INDEX.md](LOG-INDEX.md) 索引。

## 20261122-061427-m4-t5-release-integration

2026-11-22 06:14:27 PST。M4-T5 授权完成 v1.0.0 集成和发布门禁。分支为 `baton/03d01c/m4-t5`，起始工作树干净，基准提交为 `10945fa`。

- `pyproject.toml`、`src/vibebaton/__init__.py` 和 `web/package.json` 同步为 `1.0.0`。Python 分发分类改为 `Development Status :: 5 - Production/Stable`。`tests/test_version_consistency.py` 核对三个版本、变更日志的最新发布和 CLI 输出。版本修改前，测试捕获到三个清单和 CLI 的旧版本。
- Studio 的详情、最新运行和 SSE 快照已直接返回 `compute_run_telemetry`。`tests/test_web_server.py` 核对两个 JSON 入口原样返回 `billing` 和 `conflicts`。`tests/test_web_fullstack.py` 用真实 SQLite 事件验证 SSE 中的 token、成本和冲突计数，并通过 HTTP 核对 Studio 构建文件和 `/api/health` 的发布版本。
- 根目录补建项目结构索引 `CLAUDE.md`，收录 HTTP provider、沙箱模块、安装脚本和容器模板。历史施工日志通过链接沿用。
- `cmd /c "cd /d web && npx.cmd vitest run && npx.cmd tsc --noEmit && npm.cmd run build"` 退出 0。Vitest 通过 28 个文件、291 项测试，TypeScript 检查和 Vite 构建通过。Vite 报告分块体积告警。共享依赖 junction 的目标在工作树外，门禁在工作树内用已有依赖及经 SHA-256 核对的 119 个前端和预设文件运行。构建产物经 SHA-256 核对后放入 `web/dist`，临时副本已清理。
- `python -m unittest discover -s tests -v` 退出 0，共 362 项，359 项通过、3 项跳过。两项依赖 Docker CLI，一项依赖 Windows 目录符号链接权限。单独复跑 `test_web_fullstack.py` 的 3 项测试全部通过，HTTP 响应中的 HTML 和 JavaScript 与 `web/dist` 文件逐字节一致。
- `python -m vibebaton --version` 退出 0，输出 `vibebaton 1.0.0`。Python 门禁的 `PYTHONPATH` 指向本工作树的 `src`，Git 子进程沿用沙箱的工作树配置并使用本工作树的 ignore 文件。
- 已自测，待用户验收。可在 Studio 查看带用量记录的运行，核对 Model Runtime 的 token 与成本。回退参考为基准 `10945fa` 和当前工作树差异。
