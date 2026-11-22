# VibeBaton 施工日志

| ID | 日期 | 摘要 | 状态 |
| --- | --- | --- | --- |
| [20261121-051952-m1-graph-remediation](#20261121-051952-m1-graph-remediation) | 2026-11-21 | M1 入口识别、重试限额和旗舰预览汇合 | 已自测，待用户验收 |
| [20261121-095252-m1-web-resume](#20261121-095252-m1-web-resume) | 2026-11-21 | M1 Web 暂停恢复与 daemon 启动 | 已自测，待用户验收 |
| [20261121-105235-m2-dual-mode-parity](#20261121-105235-m2-dual-mode-parity) | 2026-11-21 | M2 双模式模拟一致性与旗舰节点层级 | 已自测，待用户验收 |
| [20261121-212738-m2-subscription-readiness](#20261121-212738-m2-subscription-readiness) | 2026-11-21 | M2 订阅 CLI 认证与主机就绪判断 | 已自测，待用户验收 |

## 20261121-212738-m2-subscription-readiness

2026-11-21 21:27:38 PST。M2 复审授权修复订阅 CLI 的就绪判断和本地 Key 注入。分支为 `baton/25c18a/ms-m2-r1`，起始工作树干净，基准提交为 `4c6b7a1`。

- 新增回归在基准实现上复现 17 个断言失败，涵盖无 Key 时的订阅探测与预设误判、登录提示、本地凭据文件异常和环境解析返回订阅厂商 Key。
- `src/vibebaton/credentials.py` 按 CLI 原生认证状态判断订阅就绪。在 CLI 返回失败时提供手动登录提示。API 提供商继续校验必需的 Key。存储的 Key 仅用于对应 API 提供商的环境解析。
- `GET /api/presets` 按 API 提供商映射复核密钥要求，覆盖缓存期间清除密钥的情况。就绪契约已写入 `.baton/00_RFC.md`。
- `tests/test_web_server.py` 的订阅就绪 Golden Example `test_signed_in_subscription_presets_and_roles_are_ready_without_api_keys` 通过回环 HTTP 验证 Doctor、两个同家族预设和角色模型目录。`tests/test_credentials.py` 覆盖登录状态命令、失败提示、无效凭据文件和环境解析。
- 三道门禁均返回 0。`python -m unittest discover -s tests -v` 通过 211 项，含静态资源集成测试。`python -m unittest tests.test_web_server tests.test_presets tests.test_graph_cli_mcp -v` 通过 83 项。`cmd /c "cd /d web && npx.cmd vitest run"` 通过 19 个文件、141 项。另通过 `tsc --noEmit` 和 Vite 构建。Python 进程使用本工作树的 `PYTHONPATH` 与 Git ignore 配置。
- 初次 Vitest 因共享依赖目录不可写失败，替换 junction 的方案被工具策略拒绝，系统临时目录的父路径也触发 esbuild 访问错误。最终在工作树内的临时目录用现有依赖和逐文件核对的 95 个前端及预设文件运行原门禁。构建产物用于补跑静态资源用例，测试后已清理临时副本和产物。
- 回退参考为 `4c6b7a1` 和当前工作树差异。真实账号验收可在已登录且对应 API Key 为空的主机检查 Doctor 的 `ok` 与同家族预设的 `host_ready`，预期均为 `true`。

## 20261121-105235-m2-dual-mode-parity

2026-11-21 10:52:35 PST。M2 复审授权修复模拟结果和节点层级两项阻塞。分支为 `baton/e815d5/ms-m2-r1`，起始工作树干净，基准提交为 `739b0e1`。

- `web/src/engine/localSimulator.ts` 按 Python 规则识别入口、检查循环和选择路由。运行时沿分支记录路径，返回边可继承环内限额。额度耗尽后跳过该边，当次队列为空时返回 `halted`。仅在 `happy_path` 对循环外且至少有两个输入的合并节点汇集到达项。预览时间戳采用相对时间。
- `web/src/types/graph.ts` 优先按角色确定层级，再回退到节点类型。旗舰头脑风暴和终审均为 L0 琥珀色，微观审校为 L2 天蓝色，批量任务为 L3 翡翠色。
- `web/src/engine/__fixtures__/generate_python_parity.py` 用当前工作树的 Python 引擎生成四个预设和四张自定义图的三场景样例。新增回归在基准实现上复现 24 个失败。生成文件可重复生成，SHA-256 为 `05D7A717C2BFE1DFA01969450B72486B0270079C08602B1FB25A2ED40A334687`。
- 三项门禁返回 0。Vitest 通过 81 项，`tsc --noEmit` 和 Vite 构建成功，依赖清单差异检查通过，Python unittest 通过 104 项。初次 Vite 启动因共享依赖目录不可写失败。验证使用工作树内的依赖副本，原 junction 保存在 `web/.vite/m2-verification/shared-node_modules`。Python 门禁的 `PYTHONPATH` 指向当前工作树的 `src`，子进程 Git 使用工作树的 `.gitignore`。
- 额外对照 258 张图的校验结果和 264 次模拟轨迹。另在隔离的 loopback HTTP 服务中通过 `BatonApiClient` 对照 24 次 demo 和 local 模拟，状态、访问顺序及除时间戳外的轨迹一致。构建产物入口和两项相对路径资源可经 HTTP 加载。
- React 服务端渲染核对了旗舰 10 张节点卡的标签和颜色变量。嵌入式浏览器需要当前会话无法提供的审批，独立无头浏览器启动被环境策略拒绝。实际画布待人工查看，在 `CanvasWorkspace` 载入旗舰预设时可核对上述颜色。
- 本轮差异位于当前工作树，基准为 `739b0e1`。

## 20261121-095252-m1-web-resume

2026-11-21 09:52:52 PST。M1 复审授权修复 Web 控制端点恢复运行时缺少 daemon 的阻塞。分支为 `baton/e815d5/ms-m1-r1`，起始工作树干净，基准提交为 `d5af581`。

- `tests/test_web_server.py` 的两个 `test_control_*` 回归在基准实现上确认 `resume` 返回 HTTP 200，启动器调用次数为零。
- `src/vibebaton/web_server.py` 复用现有启动助手。恢复成功时记录 `daemon_spawned` 并返回 `daemon_pid`。启动失败时恢复 `PAUSED` 并返回 HTTP 500，用户可再次恢复。成功和失败响应已写入 `.baton/00_RFC.md`。
- 三项门禁全部返回 0。全量 unittest 通过 104 项，依赖检查输出 `deps ok`，CLI 解析检查输出 `ui ok 0`。测试进程将 `PYTHONPATH` 指向当前工作树的 `src`，Git 使用进程级配置读取工作树的 `.gitignore`，避开沙箱内不可读的用户级 ignore 文件。
- 在临时 Git 仓库用预置计划和已通过的里程碑验证实际恢复。HTTP 暂停后，恢复请求返回真实 daemon 的 PID。该进程退出码为 0，`/api/runs/stream?once=1` 返回同一运行的 `READY_FOR_FINAL_GATE` 快照和 `daemon_spawned` 事件。画布交互随前端里程碑验收。
- 本轮差异在当前工作树，回退基准为 `d5af581`。验收可对已暂停且旧 daemon 已退出的本地运行发送 `resume`，核对响应中的 `daemon_pid` 与后续 SSE 状态。

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
