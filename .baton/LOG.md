# VibeBaton 施工日志

| ID | 日期 | 摘要 | 状态 |
| --- | --- | --- | --- |
| [20261121-051952-m1-graph-remediation](#20261121-051952-m1-graph-remediation) | 2026-11-21 | M1 入口识别、重试限额和旗舰预览汇合 | 已自测，待用户验收 |
| [20261121-095252-m1-web-resume](#20261121-095252-m1-web-resume) | 2026-11-21 | M1 Web 暂停恢复与 daemon 启动 | 已自测，待用户验收 |
| [20261121-105235-m2-dual-mode-parity](#20261121-105235-m2-dual-mode-parity) | 2026-11-21 | M2 双模式模拟一致性与旗舰节点层级 | 已自测，待用户验收 |
| [20261121-212738-m2-subscription-readiness](#20261121-212738-m2-subscription-readiness) | 2026-11-21 | M2 订阅 CLI 认证与主机就绪判断 | 已自测，待用户验收 |
| [20261121-231817-m4-t1-benchmark-contracts](#20261121-231817-m4-t1-benchmark-contracts) | 2026-11-21 | M4-T1 适配器契约、评估入口与 KV Memory 示例 | 已自测，待用户验收 |
| [20261122-000739-m4-t5-benchmark-runner](#20261122-000739-m4-t5-benchmark-runner) | 2026-11-22 | M4-T5 三臂 runner、计分板与门禁 | 已自测，待用户验收 |
| [20261122-002235-m4-t5-scoreboard-acl](#20261122-002235-m4-t5-scoreboard-acl) | 2026-11-22 | M4-T5 Windows 计分板权限回归修复 | 已自测，待用户验收 |
| [20261122-004033-m4-hidden-eval-remediation](#20261122-004033-m4-hidden-eval-remediation) | 2026-11-22 | M4 隐藏评估失败按臂计分并继续导出 | 已自测，待用户验收 |
| [20261122-041231-m2-merge-crash-recovery](#20261122-041231-m2-merge-crash-recovery) | 2026-11-22 | M2 恢复中断后的合并工作树 | 已自测，待用户验收 |

## 20261122-041231-m2-merge-crash-recovery

2026-11-22 04:12:31 PST。M2 复审授权修复崩溃遗留的合并工作树阻塞续跑。分支为 `baton/03d01c/ms-m2-r1`，起始工作树干净，基准提交为 `e6e813f`。

- `tests/test_conflict_resolver.py` 在临时 Git 仓库留下有未合并条目和已暂存文件的注册工作树。基准实现报 `GitError`，修复后重新触发 resolver 和门禁，目标分支提交双方改动，旧文件和工作树注册被清理。
- `src/vibebaton/git_ops.py` 让两种合并模式共用 `remove_worktree` 清理逻辑。路径校验拒绝指向其他目录的链接，回归验证目标目录内的文件和目标分支均保留。
- `python -m unittest discover -s tests -v` 通过 313 项，含静态资源和 API 的回环 HTTP 集成测试。`python -m unittest tests.test_conflict_resolver tests.test_conflict_resolver_engine tests.test_report_conflicts tests.test_e2e_pipeline -v` 通过 25 项。两条命令的 `PYTHONPATH` 指向当前工作树的 `src`，Git 子进程使用工作树的 `.gitignore`。
- `cmd /c "cd /d web && npx.cmd vitest run && npx.cmd tsc --noEmit && npm.cmd run build"` 返回 0。Vitest 通过 27 个文件、264 项，TypeScript 检查和 Vite 构建通过。Vite 报告分块体积告警。为避开指向工作树外的依赖 junction，在工作树内复制依赖和 118 个经 SHA-256 核对的输入文件。构建产物用于 Python HTTP 集成测试，验证后清理了副本和产物。
- 已自测，待用户验收。恢复场景使用真实 Git 和本地 resolver 回调。验收时可运行 `test_resolver_recovers_interrupted_squash_merge`，预期目标分支生成包含双方改动的提交，遗留工作树从 Git 注册表移除。回退参考为 `e6e813f` 和当前工作树差异。

## 20261122-004033-m4-hidden-eval-remediation

2026-11-22 00:40:33 PST。M4 复审授权修复隐藏评估超时或摘要损坏时三臂计分板无法导出的阻塞。分支为 `baton/25c18a/ms-m4-r1`，起始工作树干净，基准提交为 `fa20f65`。

- `tests/test_benchmark_harness.py` 通过本地 CLI 夹具在基准实现上复现两个失败。B 臂的适配器阻塞或直接写文件描述符 1 时，runner 均返回 1，未导出报告。
- `benchmarks/run_benchmark.py` 将超时和无效摘要计为 `0/109`。JSON 写入 `eval_error`，Markdown 标记受影响的臂，计分板均包含 A、B、C。回归验证 A 臂保持满分、C 臂完成评估并得到有效分数，同时拒绝总数为 1 的摘要。独立参考评估核对分母。
- 评估器使用单独的系统临时目录。Mock B 臂与 live 使用相同的模型命名格式，mock 导出仅列出选中的实现。评估契约已写入 `.baton/00_RFC.md`，基准 README 说明了 provider 读取隐藏测试和参考解的条件。三条历史记录已原文归档到本日志并加入索引。
- `python -m unittest discover -s tests -v` 通过 220 项，包含本地 CLI 回归与真实回环 HTTP 的静态资源集成测试。独立运行隐藏契约通过 109 项。Seed 42 的默认 mock 成绩为 `74/109`、`98/109`、`109/109`。用户指定的计分板检查输出 `scoreboard ok`，报告位于 `benchmarks/results/latest.json` 与 `benchmarks/results/latest.md`。
- 直接运行前端门禁时，Vite 写入指向工作树外的依赖 junction 返回 `EPERM`。在工作树内使用本地依赖副本和经 SHA-256 核对的 115 个前端及预设文件执行原命令。Vitest 通过 26 个文件、259 项，TypeScript 检查和 Vite 构建通过，构建有产物体积告警。全量 Python 使用该构建产物，验证结束后已清理副本及临时构建。
- 本地夹具覆盖 live 调度和评估，真实模型调用待验收。回退参考为 `fa20f65` 与当前工作树差异。

## 20261122-002235-m4-t5-scoreboard-acl

The M4-T5 controller rerun on 2026-11-22 PST hit `PermissionError` while
snapshotting `benchmarks/results/latest.json` on `baton/25c18a/m4-t5`.
Reports from the previous runner kept the private Windows ACL of the staging
directory after the move. The runner now creates each staging file in the
output directory and replaces its report after closing the file.

The harness still compares paths and readable file contents before and after
temporary-output runs. For either unreadable legacy report, it compares file
identity, size, and modification time. The regression covers metadata changes,
read errors on source files, and replacement of existing reports.

- The exact verification command exited `0` in a temporary copy of 198 inputs
  checked with SHA-256. The ten hidden contract modules passed all 109 tests,
  and Python discovery passed all 218 tests. Vitest passed 259 tests in 26 files,
  TypeScript checking passed, and Vite built with a chunk-size warning.
- The first frontend copy omitted the repository presets. The next run placed
  temporary test credentials inside the repository and hit the credential
  storage guard. The passing run copied the presets and frontend dependencies
  and used system temporary storage for test data.
- The seed-42 reports in this worktree match the gate results apart from the
  JSON generation time. Windows ACL checks showed inherited permissions on
  both reports. The live tests covered provider configuration guidance and
  dispatch through local CLI fixtures.

Status is self-tested and pending user acceptance. Real live provider calls
remain unverified. `ec1f46a` is the Git baseline before M4-T5.

## 20261122-000739-m4-t5-benchmark-runner

On 2026-11-22 PST, M4-T5 added the runner, scoreboards, and reference package
exports on `baton/25c18a/m4-t5` from base `ec1f46a`. Status is self-tested and
pending user acceptance. The base commit is the reference for reviewing and
reverting the changes.

- The aggregate reference suite passed 109 tests across all ten contract
  modules. The seed-42 mock produced 74/109, 98/109, and 109/109 passes, with
  two frozen-file changes in arm A and zero in B and C.
- `python -m unittest discover -s tests -v` passed 217 tests. The harness tests
  covered reproducible scores, unchanged benchmark sources, a broken adapter,
  unconfigured live mode, and live dispatch through local CLI fixtures. The
  fixtures verified that path and public test failures stop arm C before review.
  Real model calls remain unverified.
- The full verification sequence returned zero from a byte-verified copy of
  192 project inputs. Vitest passed 259 tests in 26 files, `tsc --noEmit` passed,
  and Vite built the production bundle with a chunk-size warning. The worktree's
  shared dependency directory resolves outside the sandbox's writable root.
  Esbuild could not read a parent of the system temporary copy, so the passing
  run used a temporary directory inside the worktree with local dependencies.

## 20261121-231817-m4-t1-benchmark-contracts

M4-T1 added the starter interfaces, task prompt, target loader, and KV Memory
example on `baton/25c18a/m4-t1` from base `63d6957`. Status is self-tested and
pending user acceptance.

- The direct and aggregate evaluators each passed 8 tests. An alternate target
  ran the same suite. Target validation rejected invalid paths and a cached
  package from a different target.
- `python -m unittest discover -s tests -v` passed 212 tests in a byte-verified
  temporary copy. In the worktree, the sandbox blocked Vite's config write
  through the shared `node_modules` junction. The temporary copy used assets
  built from this worktree with `vite build --configLoader runner`.
- Python 3.13.2 ran the tests. A separate check verified Python 3.11 syntax and
  standard-library imports. Base `63d6957` is the Git reference for reviewing
  and rolling back these additions.

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
