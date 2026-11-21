# VibeBaton 产品与工程路线图（Roadmap）

> **核心定位 / Positioning**: 跨厂商异构多 Agent 软件工厂（Heterogeneous Multi-Agent Orchestrator）——在本地工作流中自由混编 **Antigravity / Claude / Codex / OpenCode Go / DeepSeek** 与任意开源或自托管模型，以 **Contract-First + 机械门禁前置 + Git Worktree 并发隔离 + 可分享 `.baton.json` 开放配方生态** 作为核心护城河。

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

## 🚧 Stage 2 · `v0.3.0-canvas`（可视化画布与免配置双模试玩）

### 底座核心（正在自举构建中）
- **零依赖本地后端（`baton ui`）**：Python stdlib `ThreadingHTTPServer` + SSE 实时事件流，默认仅绑定 `127.0.0.1`；支持 REST API、TOML 配置热写回与 `web/dist/` 静态托管。
- **React Flow 三栏暗黑画布（`web/`）**：基于 `Vite + React + TypeScript + @xyflow/react`，支持拖拽连线、节点属性检查器、导入/导出 `.baton.json` 与 `baton.toml` 热更新。
- **双模运行（Connected Local / Standalone Demo）**：自动探测 `/api/health`，无后端时纯前端 `localSimulator.ts` 零报错接管，支持静态构建部署到 GitHub Pages（`base: './'`），30 秒零配置试玩。
- **Live Run 实时监控与发车**：直连 `/api/runs/stream` SSE 驱动画布亮灯、事件日志流、战报预览及 `Start Real Run` / `Pause` / `Resume` / `Resolve`。

### 终审发布前的 3 项高传播精修（已定型纳入 `v0.3.0`）
1. ⚡ **“接力棒”三色语义粒子流（Baton Flow Visuals）**：在激活边上通过 SVG `<animateMotion>` 渲染流动接力粒子并按事件语义变色（正常交棒 **青绿** / 门禁或微审打回 **琥珀橙** / 熔断升级 **洋红**），节点显示呼吸光环、运行计时与并发角标。
2. 🎬 **Stage 1 真实自举战报 60× 时间旅行回放（Real Run Replay）**：将 `run-20261121-044454-3b1845` 的脱敏真实事件流内嵌进画布，路人可在 GitHub Pages 一键回放四层真 AI 如何抓出 3 个架构 Bug、打回返修与触发沙箱熔断。
3. 🔗 **零后端 URL 配方分享（Shareable `#recipe=...` Hash）**：将当前 `.baton.json` 压缩编码进 URL Hash，实现无需服务器的社区工作流一键分享与打开试跑。

---

## 📋 Stage 3 · `v0.9-beta`（智能配给、场景配方生态与硬核对比实测）

详见完整技术草案：[RFC_STAGE3_DRAFT.md](RFC_STAGE3_DRAFT.md)。核心五大特性：

1. **场景化 & 单厂商全家桶配方广场（Scenario & Same-Family Recipes）**
   - 按 `same_family`（纯 Claude / 纯 Codex / 纯 DeepSeek）、`bulk_batch`、`small_project`、`audit_only` 分类，并标注 `required_providers`、`cost_tier` 与 `inspired_by`（社区验证范式出处，开放 `recipes/` PR）。
   - 结合 `baton doctor` 结果自动高亮标绿“本机开箱可用”的配方。
2. **✨ 统一智能配给模式（Unified Smart Allocation）**
   - 一套机制同时解决**中等项目**（单模型按复杂度动态调节 `@low / @high / @max` 思考深度）与**重型项目**（跨厂商模型 + 思考深度联合配给）：
     - 提供 **3 档预算偏置**：`Eco（省钱极速）` / `Balanced（均衡默认）` / `Max Quality（极致质量）`；
     - **受约束候选池**：基于 `baton doctor` 与 `baton.toml` 生成可用能力目录，禁止 AI 幻觉出不存在的模型；
     - **规划期一次配给 + 运行期零成本阶梯升档**：失败时自动升档（如 `flash@low → flash@max → gpt-6.2-sol@max`），且支持画布侧边栏单节点锁定覆写（Pin）。
3. **交互式头脑风暴入口 + RFC 机械体检（Brainstorm Gate）**
   - 在 `baton ui` 发车向导前置 2~3 轮对话式头脑风暴，自动收敛出结构化 `00_RFC.md`；
   - 允许用户点击“跳过”，但跳过前必经 RFC 机械体检（检查是否缺失可自动化验收命令或范围边界），给出**具体风险提示**后再确认放行（命令行/MCP 无头自动化模式保持畅通不阻塞）。
4. **前置配置体检 + API Key 引导 + 节点 5 秒一键测活（Preflight & Click-to-Doctor）**
   - 发车前自动检测 CLI/Key 就绪状态并在节点显示 `🟢 / 🟡 / 🔴`；
   - 支持界面引导填写 OpenAI 兼容 / DeepSeek / OpenCode Go API Key 并现场 5 秒测通；**明确不尝试自动安装或静默 OAuth 登录第三方闭源订阅 CLI**，缺失时提供可复制的官方命令并自动推荐“本机已就绪的替代配方”。
5. **公开可复现 3 组对照 Benchmark（`benchmarks/`）**
   - 选取**中型多模块 + 严格契约**战场，以所有组均不可见的 **Hidden Eval Suite（隐藏验收测试集）** 客观对比：
     - 组 A：纯廉价单模型
     - 组 B：纯旗舰单模型串行
     - 组 C：VibeBaton 四层混编
   - 输出可复现仓库与真实“测试通过率 × 高阶调用占比 × 总耗时”数据看板。

---

## 🚀 Stage 4 · `v1.0`（正式全网首发）

1. **原生 OpenAI 兼容 API Provider**：不依赖外部 CLI 即可直连 API，提供精确 Token 用量与美元成本账单。
2. **Auto-Conflict-Resolver 兜底节点**：并发分支合入冲突时自动派发 Specialist 解决而非直接报错停机。
3. **Docker / DevContainer 隔离运行模板**：为跑不可信第三方仓库提供 OS 级容器沙箱（见 [SECURITY.md](SECURITY.md)）。
4. **Windows 一键安装打包 & 国内外正式发布**（Show HN / Product Hunt / 科技周刊 / V2EX / Linux.do）。
