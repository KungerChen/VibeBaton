# VibeBaton 施工日志

| ID | 日期 | 摘要 | 状态 |
| --- | --- | --- | --- |
| [20261121-051952-m1-graph-remediation](#20261121-051952-m1-graph-remediation) | 2026-11-21 | M1 入口识别、重试限额和旗舰预览汇合 | 已自测，待用户验收 |

## 20261121-051952-m1-graph-remediation

2026-11-21 05:19:52 PST。M1 审查授权修复图契约和 Golden Example 的三项阻塞。工作分支为 `baton/3b1845/ms-m1-r0`，起始工作树干净，基准提交为 `eb0adbc`。

- 复现证据位于 `tests/test_graph_schema.py` 和 `tests/test_graph_engine.py`。原有 32 项图测试通过。加入回归后，37 项测试报告 17 个断言失败（含子用例）。Golden Example 在前向边 `e2` 提前耗尽额度，专用 `fixer` 被列为入口，旗舰预览重复执行合并、里程碑审查和人工验收。
- `src/vibebaton/graph_schema.py` 优先采用零入度节点。尚未可达的循环可通过带标记的实际反馈边确定入口。
- `src/vibebaton/graph_engine.py` 仅在当前分支返回路径上的节点时继承节点限额。边上的显式限额优先，按边累计。Golden Example 在 `presets/solo_coder_3tier.baton.json` 中用 `e4` 和 `e6` 分别声明两次门禁重试和一次审校整改额度，移除门禁节点上的重复配置。
- `happy_path` 预览让循环之外的合并节点等待队列中可到达该合并的上游节点，然后把已到达的分支合成一次访问。旗舰的合并、审查和人工验收各执行一次。回归覆盖两条分支均到达和另一条分支未选中两种情况。
- 两条 unittest 门禁显式设置 `PYTHONPATH` 指向当前工作树的 `src`。最终全量测试用进程级 Git 配置避开沙箱内不可读的用户级 ignore 文件。
- `python -m unittest tests.test_graph_schema tests.test_graph_engine -v` 通过 38 项。自定义处理器覆盖连续两次门禁失败、门禁失败加审校整改、以及两项额度在同一轮用满。所有组合都完成，也验证了保留旧节点配置的兼容情况。
- 三个预设全部验证通过，九个预设与场景组合均返回 `completed`。`python -m unittest discover -s tests -v` 通过 44 项，包含使用真实 Git worktree 和 Mock CLI 的集成测试。`python -m doctest -v src/vibebaton/graph_engine.py` 通过 6 项。
- 专用修复节点的模拟访问顺序为 `w → g → h`（通过）和 `w → g → fixer → g → h`（失败后重试）。
- 本轮差异位于当前工作树，回退基准为 `eb0adbc`。验收时可运行上述门禁，并核对旗舰 `happy_path` 中两条分支在合并前完成。
