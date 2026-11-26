# 项目协作入口

- 当前能力、运行方式与结构见 [README.md](README.md)。
- 目标与验收复用 [.baton/00_RFC.md](.baton/00_RFC.md)、[路线图](docs/ROADMAP.md) 和 [Guided Lineage 契约](docs/guided2/lineage_contract.md)；阶段 3 历史设计见 [RFC](docs/RFC_STAGE3_DRAFT.md)。
- 施工记录先查 [LOG-INDEX.md](LOG-INDEX.md)，再按 ID 查 [LOG.md](LOG.md)。
- Python 实现在 `src/vibebaton/`，回归测试在 `tests/`，Studio 前端在 `web/`。
- 在仓库根目录验证 Python 前，确保 `PYTHONPATH` 优先指向当前工作树的 `src`。PowerShell 可运行 `$env:PYTHONPATH = Join-Path (Get-Location) 'src'`，然后运行 `python -m unittest discover -s tests`。
- 前端构建在 `web/` 运行 `npm run build`。若 `node_modules` 是只读共享链接，可用 `npm run build -- --configLoader runner` 避免默认配置加载器向链接目标写临时文件。
