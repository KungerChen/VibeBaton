ID | 日期 | 行为 | LOG.md 起始行 | commit hash
--- | --- | --- | --- | ---
L0001 | 2026-11-25 | 模型目录：按退役日期下架、同步降噪、每日后台同步、Claude 真实 ID | 5 | 8746ba9
L0002 | 2026-11-25 | 旧 Claude 模型 ID 覆盖值自动迁移 | 32 | 839f0e7
L0003 | 2026-11-25 | 模型目录：订阅 CLI 列表为准、恢复 DSH 下拉、数据清理、推荐落在可用模型 | 51 | 6548e80
L0004 | 2026-11-25 | 头脑风暴：11 个结构化场景、项目摘要、平实提示词、使用 L0 模型 | 79 | b0a04a2
L0005 | 2026-11-25 | 图标按尺寸从 SVG 渲染；任务栏发糊实测为 Chromium 放大 16dip favicon，声明与一次性 WM_SETICON 均无效 | 104 | 341f9cb
L0006 | 2026-11-26 | 引导模式蓝图：一句话起步、一次一问、清单逐项点亮、失败可见可重试 | 127 | c763ca5
L0007 | 2026-11-26 | 离线蓝图：无检查命令时追问命令而非说可以开工；给谁用写进 RFC | 154 | 856d611
L0008 | 2026-11-26 | 无 Git 身份时初始化仓库补仓库级身份与首个提交；无提交仓库拒绝开工 | 174 | 61b6880

## 后续记录

ID | 日期 | 摘要 | 日志路径与锚点 | 状态
--- | --- | --- | --- | ---
20261126-080223-m1-favicon-gate | 2026-11-26 | M1 全量门禁：修正过时的 ICO 断言并验证实际资源 | [LOG.md](LOG.md#20261126-080223-m1-favicon-gate) | 用户已验收（2026-11-27）
20261126-082838-m2-session-contract | 2026-11-26 | M2-T1 会话存储、推荐接口及契约 | [LOG.md](LOG.md#20261126-082838-m2-session-contract) | 用户已验收（2026-11-27）
20261126-115602-m2-guided-integration | 2026-11-26 | M2-T4 会话 API、推荐与启动前检查 | [LOG.md](LOG.md#20261126-115602-m2-guided-integration) | 用户已验收（2026-11-27）
20261126-122618-m2-brainstorm-lock | 2026-11-26 | M2 会话锁并发修复与回归 | [LOG.md](LOG.md#20261126-122618-m2-brainstorm-lock) | 用户已验收（2026-11-27）
20261126-123140-m2-gates | 2026-11-26 | M2 前三项门禁、panel 夹具和历史记录迁移 | [LOG.md](LOG.md#20261126-123140-m2-gates) | 用户已验收（2026-11-27）
20261126-123645-m2-scan-stale-response | 2026-11-26 | 扫描期间草稿更新和重置的过时响应保护 | [LOG.md](LOG.md#20261126-123645-m2-scan-stale-response) | 用户已验收（2026-11-27）
20261126-124814-m2-remediation-verification | 2026-11-26 | M2 最终四项门禁、跳过项与验收边界 | [LOG.md](LOG.md#20261126-124814-m2-remediation-verification) | 用户已验收（2026-11-27）
20261126-183037-m3-t6-guided-loop | 2026-11-26 | M3 Guided 四阶段闭环与会话恢复 | [LOG.md](LOG.md#20261126-183037-m3-t6-guided-loop) | 用户已验收（2026-11-27）
20261126-211349-workflow-recommendation | 2026-11-26 | 推荐工作流按规模分档、保留定制团队、panel 全员就绪才推荐；推荐卡片重排 | [LOG.md](LOG.md#20261126-211349-workflow-recommendation) | 已自测待用户验收
20261126-221815-provider-names-launch-card | 2026-11-26 | 工具显示名统一；推荐卡片移到对话区下方横向展开 | [LOG.md](LOG.md#20261126-221815-provider-names-launch-card) | 已自测待用户验收
20261126-233025-studio-master-plan | 2026-11-26 | Studio 总体执行方案书（三幕工作台 + Lab）与三项已拍板决策，仅文档 | [LOG.md](LOG.md#20261126-233025-studio-master-plan) | 文档已写，待用户审阅
20261127-0940-small-project-lean-plan | 2026-11-27 | 小项目规划精简：规模传到规划指令、去掉逐任务审校 | [LOG.md](LOG.md#20261127-0940-small-project-lean-plan) | 已自测待用户验收
20261127-1300-effort-source-of-truth | 2026-11-27 | 思考强度来自工具/声明/feed 数据，所有出口统一校验；小项目团队两种型号 | [LOG.md](LOG.md#20261127-1300-effort-source-of-truth) | 已自测待用户验收
20261127-m3-accepted | 2026-11-27 | 用户确认 M3 验收通过；立项前核实假设 1、5、7 | [LOG.md](LOG.md#20261127-m3-accepted) | M3 已验收
20261127-rfc-studio-workbench-p1 | 2026-11-27 | 新 RFC 立项：Studio Workbench Phase 1 + 小任务精简流程；Guided 2.0 RFC 归档 | [LOG.md](LOG.md#20261127-rfc-studio-workbench-p1) | RFC 已立项，未施工
20261127-rfc-roadmap-section | 2026-11-27 | 现行 RFC 末尾加后续各期路线图（仅信息，不进本期范围） | [LOG.md](LOG.md#20261127-rfc-roadmap-section) | 已写入
20261127-p1-m1-lean-flow | 2026-11-27 | Phase 1 里程碑 1：小任务精简流程（跳过规划、一做一审）、单次运行开关、推荐里的流程字段；真实规划模型未把路线图拆进计划 | [LOG.md](LOG.md#20261127-p1-m1-lean-flow) | 已自测并交付，待用户验收
20261127-p1-m2-one-launch-path | 2026-11-27 | Phase 1 里程碑 2：蓝图"粘贴 RFC"快车道、发车卡内确认（团队、模式、流程、项目预算）、精简流程开关；删除 StartRunModal，三处入口统一进工作台；浏览器走通旅程 2（超时重试只得到一个运行） | [LOG.md](LOG.md#20261127-p1-m2-one-launch-path) | 已自测并交付，待用户验收
20261127-p1-m3-three-act-shell | 2026-11-27 | Phase 1 里程碑 3：默认进工作台、阶段轨只编号蓝图/施工/验收、setup 降为就绪胶囊（缺什么才展开向导，只拦发车不改阶段）；验收页合并结果与验证结果分开、空门禁显示"无门禁记录"；费用显示"未上报"并给出覆盖率 | [LOG.md](LOG.md#20261127-p1-m3-three-act-shell) | 已自测并交付，待用户验收
20261127-windows-posix-gate-fix | 2026-11-27 | Windows 下 POSIX 门禁命令改由 Git Bash 执行、修复 GBK 输出解码乱码，并约束头脑风暴/规划提示词只生成跨平台验证命令 | [LOG.md](LOG.md#20261127-windows-posix-gate-fix) | 已自测通过
20261127-p1-wrapup | 2026-11-27 | Phase 1 收尾：八条验收标准逐条证据；最终外壳上重走旅程 2（零点击到蓝图、超时重试只得到一个运行）；README 与教程按现状更新；假设 7 成立 | [LOG.md](LOG.md#20261127-p1-wrapup) | Phase 1 已交付，待用户验收
20261127-p2-prep-artifact-key | 2026-11-27 | Phase 2 准备：`role_invoked` 事件补 `artifact_key`（纯增量）；方案书假设 1 补上后成立（三处边界），假设 2 在遥测里不成立、可由事件推出，只影响 Phase 3 | [LOG.md](LOG.md#20261127-p2-prep-artifact-key) | 已自测并交付
20261127-rfc-studio-workbench-p2 | 2026-11-27 | 新 RFC 立项：Studio Workbench Phase 2（运行存储、只读接力图、情境抽屉与底坞、LiveRunPanel 字段迁移、交接卡、证据矩阵三态）；Phase 1 RFC 归档；与方案书的差异：门禁回执事件、三个只读接口、字面引用规则 | [LOG.md](LOG.md#20261127-rfc-studio-workbench-p2) | RFC 已立项，未施工
20261127-p2-m1-run-store | 2026-11-27 | Phase 2 里程碑 1：运行存储（一条事件流、显式跟随最新运行、运行控制）；四处门禁留 `gate_receipt` 回执；证据模块与三个只读接口（交接、交接物、证据表三态）；浏览器确认工作台与专业界面同一运行、只开一条流 | [LOG.md](LOG.md#20261127-p2-m1-run-store) | 已自测并交付，待用户验收
