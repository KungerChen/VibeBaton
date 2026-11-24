# VibeBaton 产品与工程路线图（Roadmap）

> **核心定位 / Positioning**: 跨厂商异构多 Agent 软件工厂（Heterogeneous Multi-Agent Orchestrator）——在本地工作流中自由混编 **Antigravity / Claude / Codex / OpenCode Go / DSH** 与任意开源或自托管模型，以 **Contract-First + 机械门禁前置 + Git Worktree 并发隔离 + 可分享 `.baton.json` 开放配方生态** 作为核心护城河。

---

## 已完成里程碑

### ✅ Stage 0 · `v0.1-seed`（最小自举火种）
- 纯 Python 3.11+ 标准库零依赖核心（SQLite WAL 状态机、Windows 进程树防卡死、订阅配额 429 冷却续跑、Git Worktree 并发隔离、路径白名单物理守卫、机械门禁、`baton doctor`、`baton report`、零依赖 MCP Stdio Server 与 `promote-seed` 双份安全自举）。

### ✅ Stage 1 · `v0.2.0`（声明式节点图引擎，首次四层自举完成）
- **自举战果**：以 `v0.1-seed` 为外部母机驱动四层 AI（`107 分钟`、`3/3` 里程碑、`9/9` 任务），自动产出：
  - `graph_schema.py`：7 种原子节点类型（`planner_node` / `router_node` / `worker_node` / `gate_node` / `reviewer_node` / `merge_node` / `human_gate_node`）与受控循环校验；
  - `graph_engine.py`：异步节点图执行器、`max_loops` 熔断器与 3 套确定性 Mock 模拟剧本（`happy_path` / `gate_retry` / `escalate`）；
  - `presets.py` + 4 套官方 `.baton.json` 预设；
  - `baton presets` / `baton graph` CLI 与 2 个新 MCP 工具（共计 9 个）；
  - 测试从 6 项增至 **63 项全绿**（零第三方运行时依赖），并将三点式 `merge-base` 并发隔离、里程碑级 `MINOR_FIX` 自动返修与 Windows `/dev/null -> NUL` 门禁兼容回迁入主仓。

---

## ✅ Stage 2 · `v0.3.0-canvas`（已完成并合入 `main`：`9a1e662`）

- **零依赖本地后端（`baton ui`）**：Python stdlib `ThreadingHTTPServer` + SSE 实时事件流，默认仅绑定 `127.0.0.1`；支持 REST API、TOML 配置热写回与 `web/dist/` 静态托管。
- **现代工作室双模画布（`web/`）**：基于 `Vite + React 19 + TypeScript + @xyflow/react + Tailwind CSS v4 + shadcn/ui + React Flow UI`，Dify / n8n 现代工作流审美，支持拖拽连线、节点属性检查器、导入/导出 `.baton.json`、`baton.toml` 热更新与 `localSimulator.ts` 纯前端离线试玩（141 前端 + 106 后端全栈测试全绿）。
- **已落地精修与体验升级**：
  1. ⚡ **接力棒三色语义粒子流（Baton Flow Visuals）**、🎬 **Stage 1 60× 真实自举战报回放**、🔗 **零后端 `#recipe=` URL 分享**；
  2. 🌐 **纯英文默认 + `EN | 中文` 完整双语切换**、DSH 展示统一、事件日志本地化与战报 Markdown 渲染、交互式 Quick Start 新手引导；
  3. 💧 **Liquid Theme Reveal + 同步 Web Audio 音效**（SVG `<clipPath>` 双层无闪烁揭示、音画阶段同步、开关与音量记忆、移动端响应式适配）。

---

## ✅ Stage 3 · `v0.9.0-beta`（已正式合入 `main`：`0287990`）

详见技术规格与新手教程：[RFC_STAGE3_DRAFT.md](RFC_STAGE3_DRAFT.md) · [新手保姆级教程 TUTORIAL.md](TUTORIAL.md)。核心落地特性与精修：

1. **场景化 & 单厂商全家桶配方广场（Recipe Plaza · 7 套预设）**
   - 支持 `same_family`（`claude_only_3tier` / `codex_only_3tier` / `deepseek_bulk_factory`）、`bulk_batch`、`small_project`、`audit` 分类，结合 `baton doctor` 自动标绿「本机就绪」预设。
2. **✨ 统一智能配给模式（Unified Smart Allocation）**
   - `eco` / `balanced` / `max_quality` 三档预算策略 + 受约束候选目录 + 运行期零成本阶梯升档（`@low → @max → flagship`）与单节点 Pin 锁定。
3. **交互式头脑风暴与 RFC 机械体检 + 5 秒一键测活（Preflight & Brainstorm Gate）**
   - 发车向导前置 3 步闭环（本机 CLI 与 API Key 就绪检查 / 5 秒 Doctor / 结构化头脑风暴与 `safe_for_overnight` 评分 / **发车前分工与安全护栏总览**）。
4. **体验精修（实时画布、阶段耗时、双语战报与小白教程）**
   - **实时画布联动**：左侧新增「实时运行工作流」入口，点击即可把当前运行/历史运行的真实 `01_PLAN` / 里程碑 / 任务 DAG 与流光脉冲同步到主画布。
   - **全链路耗时统计**：引擎埋点 `role_completed` 与动态时间戳，输出 **Stage Timing（`01_PLAN` 与 M1~M4）** 与 **Model Runtime（含 `DSH` 展示名）**；支持 **历史运行下拉切换** 与 **任务行展开审校/门禁/白名单详情**。
   - **完整 `EN | 中文` 双语战报 & 零基础教程**：`generate_battle_report` 支持中英文切换并在界面开关切换时自动重拉；内置引导弹窗新增第 3 标签页 **「详细教程」** 并沉淀独立文档 `docs/TUTORIAL.md`。
5. **公开可复现 3 组对照 Benchmark Harness（`benchmarks/`）**
   - 提供对比剧本与 Hidden Eval Runner，记录通过率 × 高阶调用占比 × 阶段耗时基准。

---

## ✅ Stage 4 · `v1.0.0`（已完成并正式发布：2026-11-22）

1. **原生 OpenAI 兼容 API Provider**：纯标准库直连 `/v1/chat/completions` 接口（不依赖外部 CLI），内置精确 Token 用量统计与美元成本账单，接入现有 429 冷却池与双语战报。
2. **Auto-Conflict-Resolver 兜底机制**：并发分支在隔离合入工作树发生冲突时自动派发 Specialist 解决并复检冲突标记与机械门禁，替代直接报错停机。
3. **Docker / DevContainer 隔离运行模板与 `baton sandbox init`**：为运行不可信第三方仓库提供最小权限 OS 级容器沙箱（见 [SECURITY.md](SECURITY.md)）。
4. **Windows 一键安装脚本、Web Studio 成本与冲突看板、`v1.0.0` 正式发版**（`scripts/install.ps1`、`CHANGELOG.md`、`docs/RELEASE_NOTES_v1.0.md` 与国内外公开发布文档）。

> `v1.0.0` 已于 2026-11-22 正式发布，并在 `ecab208` 合入 `main`。完整变更见 [CHANGELOG.md](../CHANGELOG.md) 与 [RELEASE_NOTES_v1.0.md](RELEASE_NOTES_v1.0.md)。

---

## ✅ Stage 4.5 · `v1.0.1`（Studio 体验升级，已交付）

1. 左侧栏和右检查器支持鼠标与键盘调整宽度，并记住用户设置。可展开的任务卡集中显示门禁、审校和路径白名单详情。
2. 实时遥测提供服务端时间与阶段、模型和任务的计时锚点。画布、实时运行卡与检查器的活动计时每秒刷新，历史运行显示记录值。
3. 双语聚光导览从快速开始或详细教程启动。带运行记录的本地模式走七步，离线演示走六步。内置教程提供三幅随主题切换的 SVG 图，独立教程提供接力流程和工作树守卫的 Mermaid 图。[教程](TUTORIAL.md)

---

## ✅ Stage 4.6 · `v1.0.2` — Explicit Overnight Notifications & Attention Alerts（已正式发布：2026-11-22）

1. 新增 `[notifications]` 配置表与纯标准库 `AttentionNotifier`：支持飞书、企业微信、钉钉、Slack、Discord 与通用 Webhook，并提供 Windows 桌面通知和终端响铃。
2. 结构化 `human_attention_required` 事件与 `telemetry.attention`，覆盖 `waiting_human` / `ready_for_final_gate` / `failed` / `paused` / `long_cooldown` / `test` 六种注意力状态；`baton notify-test` 可逐通道自检。
3. Web Studio 新增 `AttentionBanner`，支持浏览器通知、标签页闪烁与提示音，并保持 `EN | 中文` 双语一致。

---

## ✅ Stage 4.7 · v1.0.3 — 3-Tier Pricing Engine & DSH Branding（已正式发布：2026-11-22）

1. **3 层定价引擎**：内置美元价目表、24h 官方价格源缓存与自定义逐模型覆盖，按 `custom` > `official_cache` > `builtin` 顺序解析；新增 `baton pricing sync` / `baton pricing show` 命令与 `/api/pricing`、`/api/pricing/sync`、`/api/pricing/custom` 接口。
2. **全 CLI JSON / JSONL 用量与成本采集**：Claude、Codex、DSH / OpenCode 等外部 CLI 的 token 用量与 `cost_usd` 统一进入遥测与双语战报。
3. **Studio API Pricing 弹窗**：查看解析后的费率与来源、触发官方价格同步、编辑或重置自定义费率，保持 `EN | 中文` 双语一致。
4. **DSH 品牌统一**：CLI、Studio、战报与文档中的展示名统一为 `DSH`。

---

## ✅ Stage 4.8 · v1.0.4 — Intuitive Recipe Backup/Share, Sanitized Case Export & Universal Case Replay（已正式发布：2026-11-22）

1. **左侧「配方与案例分享（Save, Import & Share）」专区**：用一句话区分配方（`.baton.json`，保存工作流图与模型路由，不含运行记录）与运行案例（`.baton-case.json`，脱敏后的图 + 轨迹 + 元数据 + 脱敏报告），并提供导入、导出配方、导出案例三张动作卡。配方会把当前工作流图原样序列化，节点标题、配置等自定义内容会一并带出，分享前可用「预览 JSON」检查是否含本机路径或密钥。
2. **四层脱敏案例导出**：密钥、主机路径与用户名、邮箱与内网 IP、原始 diff 与堆栈四层清洗，附可核验的 `redaction_report`（含 `clean` 标志）；新增 `baton export-case --repo . --run-id <id>` 命令与 `GET /api/runs/{id}/case-export` 接口。
3. **通用案例回放播放器**：顶部中央播放条默认显示「示范教程：一期真跑」，载入社区分享的案例后切换为「▶ 开始回放：<案例名>」，支持案例切换、导入其他案例与返回示范教程；画布、粒子流、节点状态与右侧轨迹联动。
4. **导入自动识别与预览确认**：文件选择、拖拽或粘贴 `.baton.json` / `.baton-case.json` / `#recipe=` 链接后自动识别类型，先展示节点数、连线数与结构校验徽章；运行案例还会显示耗时、任务数与脱敏状态徽章，再确认应用或回放，避免误覆盖画布。
5. **文档与双语一致性**：`docs/TUTORIAL.md` 新增「配方分享与案例回放」章节；`QuickStartModal` 的一期真跑步骤明确指引用案例回放；`EN | 中文` 文案与 `v1.0.4` 版本元数据同步更新。

---

## ✅ Stage 5 · `v1.1.0` — Specialist Panel mode（已正式发布：2026-11-23）

1. **多专家会诊阶段（`00_PANEL`）**：`baton.toml` 新增 `[panel]` 与 `[[panel.members]]` 配置，多位只读专家按 `max_concurrency` 并发审查 RFC，Synthesizer 将各方意见合并为 `master_spec.md`；单个专家失败会被跳过，全部专家失败或合成失败才会让运行失败。
2. **会诊结论直接进入规划**：`master_spec.md` 会追加到原 RFC 之后，作为 `01_PLAN` 规划师的输入；中断恢复时复用已生成的 master spec，不重复调用专家。
3. **双入口启动**：CLI 支持 `baton run --mode panel`，Studio「Start Real Run」向导提供 **Specialist Panel + Execute** 选项，REST 运行接口同时接受 `mode: "panel"`。
4. **可观测性与案例生态**：`00_PANEL` 阶段耗时、逐专家 token 与成本进入实时看板、双语战报和 `.baton-case.json` 脱敏案例导出；内置 `specialist_panel` 预设，Studio 可实时跟随每位专家与合成过程，保持 `EN | 中文` 双语一致。
5. **成本均衡档位默认值（cost-balanced tier defaults）**：`hydrogen` 归入 `eco` 档，`sonnet` / `neon` / `sol` 归入 `standard` 档，使默认模型选型更贴近成本与质量的平衡点。

> `v1.1.0` 已于 2026-11-23 正式发布。完整变更见 [CHANGELOG.md](../CHANGELOG.md)。
