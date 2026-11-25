# VibeBaton 施工日志

只在末尾追加，不改写旧条目。目录见 `LOG-INDEX.md`。

## L0001 2026-11-25 模型目录：按退役日期下架、同步降噪、每日后台同步、Claude 真实 ID

**目的**：让「自定义角色分工」的模型下拉覆盖主流在役模型、每天自动更新一次，且只给已配置供应商展示能实际调用的模型。范围限定在现有供应商（claude_sub / codex_sub / openai_http / gemini_sub / gemini_http / dsh_opencode / dsh_deepseek），不新增供应商、不改 `baton.toml` 数据模型，数据源仍是 LiteLLM feed。

**改动文件**：
- `src/vibebaton/model_catalog.py`：退役判断、第一方行筛选、降噪、标签/rank、`last_error`、`start_daily_sync`、Claude ID 改名、旧版 OpenAI 模型只挂 `openai_http`。
- `src/vibebaton/web_server.py`：`VibeBatonWebServer.serve_forever` 启动每日同步线程；`GET /api/models/catalog` 不再按请求起同步线程。
- `web/src/components/guided/GuidedSetupStep.tsx`、`web/src/api/client.ts`、`web/src/i18n/messages.ts`：stale 时 30s 后重拉一次目录；同步失败提示；内置目录缩为推荐模型；按 provider 命令模板隐藏不生效的模型/思考强度下拉。
- 测试：`tests/test_model_catalog.py`（3 → 19 个）、`tests/test_web_server.py`（+2）、`GuidedSetupStep.test.ts`（+5）。

**决策原因**：
- `deprecation_date` 原来只要存在就丢弃，误删在役模型；改为解析日期、<= 今天才算下架，解析失败视为在役。下架 ID 存入缓存 `retired_ids`，用于隐藏同名内置条目。
- 只采纳第一方行（anthropic / openai / gemini / deepseek）。Gemini 取 `gemini/` 前缀行（Gemini API），因为裸 ID 行多为 Vertex，且退役日期不同（如 gemini-2.5-pro：Vertex 2026-10-20，Gemini API 2026-12-01）；gemini-4 系列也只出现在 `gemini/` 前缀下。
- 实测 feed 后补充过滤：`ft:` 微调、gemma / lyria / genie 等同供应商非本家族产品；并修正 `"gemini"` 含子串 `"mini"` 导致所有同步 Gemini 被判为 eco 的问题（改为按 `-` 分词匹配）。
- 旧格式缓存（无 `retired_ids`）视为过期以触发一次重抓，否则升级后最多 24h 仍显示旧的噪音列表（实测本机即如此）。
- 同步由服务启动时的 daemon 线程负责（立即一次、之后每小时检查、满 24h 才抓），GET 只报告 stale，避免重复抓取和测试联网；仍保留 `VIBEBATON_DISABLE_MODEL_SYNC=1`。
- 实测 `claude -p --model opus-5.5` / `fable-5.2` 返回 "issue with the selected model"（0 消耗）；`claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-5-5` 正常；`claude-fable-5-2` 打印 unrecognized_model 警告但实际执行成功。故内置 ID 改为真实 ID，与同步条目自然去重。
- 本机 Codex 自身模型列表（`~/.codex/models_cache.json`，client 0.171.0）只含 gpt-6.x / gpt-5.6 系列，故 7 个旧版 OpenAI 内置条目改为只挂 `openai_http`；同步来的 OpenAI 条目无法逐个确认，保持两者都挂。
- 前端内置目录与后端重复维护 30 条 → 只保留推荐模型作离线兜底，完整列表以后端为准。
- 放弃方案：读取 `~/.codex/models_cache.json` 动态拆分 Codex 模型（新增功能、超出范围）；为旧 `opus-5.5` 等覆盖值做别名迁移（涉及配置数据，留给用户决定）。

**验证**：
- 已验证：后端指定 6 个测试模块 207 个测试通过（需 `PYTHONPATH=src`）；前端 vitest 692 通过、`tsc --noEmit` 通过、`npm run build` 成功；用真实 feed 同步得到 54 条同步模型、4 个内置条目被下架隐藏；实际启动 Studio 服务后 3 秒内后台线程完成抓取，缓存升级为新格式。
- 未验证：引导界面中下拉隐藏/失败提示的实际渲染（仅单元测试覆盖）；gemini CLI / dsh 的实际调用。

**commit**：8746ba9

## L0002 2026-11-25 旧 Claude 模型 ID 覆盖值自动迁移

**目的**：L0001 把内置 Claude ID 改成真实 ID 后，已保存的旧覆盖值（如 `claude_sub:opus-5.5@high`）仍会被 `claude --model` 拒绝，需要自动映射到新 ID。

**改动文件**：
- `src/vibebaton/config.py`：新增 `_LEGACY_CLAUDE_MODEL_IDS`，`resolve_role` 在应用覆盖值后，对 `claude_sub` 把 `fable-5.2` / `opus-5.5` / `sonnet-5.5` / `haiku-5.5` 映射为真实 ID，保留 `@effort` 后缀。
- `tests/test_core.py`：新增 1 个测试。

**决策原因**：
- 引导页的分工只存在页面内存中，不落盘；旧 ID 真正留存的地方是数据库里已有运行的 `model_overrides_json`，以及手填的覆盖 JSON / CLI / MCP 参数。这些路径都经过 `resolve_role`，所以只在这一处映射，不改写数据库、不动前端。
- 仅对 `claude_sub` 生效，其他供应商的同名 ID 原样保留；`baton.toml` 里角色自身的 `model` 不做映射（不在本次要求内）。
- 放弃方案：批量改写数据库历史记录（不可逆，且历史记录应保持原样）。

**验证**：
- 已验证：新测试先失败后通过；后端指定 6 个模块加 `tests.test_core` 共 213 个测试通过（`PYTHONPATH=src`）；前端 vitest 692 通过、`tsc --noEmit` 通过、`npm run build` 成功。
- 未验证：用旧覆盖值实际恢复一次历史运行。

**commit**：839f0e7

## L0003 2026-11-25 模型目录准确性：订阅 CLI 以自身报告为准、恢复 DSH 下拉、数据清理

**目的**：让「自定义角色分工」只展示各供应商实际能调用的模型与强度，修复上一轮把 DSH 下拉隐藏的回归，并让默认推荐落在可用模型上。

**改动文件**：
- `src/vibebaton/model_catalog.py`：`parse_gemini_model_list` / `parse_codex_models_cache` / `probe_cli_models`（每日同步时探测并写入缓存 `cli_models`，读目录时 `_apply_cli_models` 套用）；条目新增 `provider_efforts`；数据源成功同步时，本家族里完全缺席的内置条目视为下架（`_FEED_ABSENCE_EXEMPT_IDS` 豁免 `deepseek-v4.1-flash`）；排除 `claude-mythos-*`；DeepSeek 拆渠道（只认数据源无前缀行 → `dsh_deepseek`；`dsh_opencode` 只列 patch yml 的两个 DeepSeek 模型；新增内置 `deepseek-v4-flash`）；标签统一由 `_model_label` 生成；`_rank_catalog` 把同步与内置模型按版本统一排序；`luna`/`terra` 归 eco；`recommend_role_assignment` 在供应商缺该模型时回退到该供应商同档位模型。
- `src/vibebaton/web_server.py`：手动同步也刷新 CLI 列表（`server.cli_model_probe` 可注入）。
- `src/vibebaton/pricing.py`：`@ultra` 后缀在计价时剥离。
- `web/src/components/guided/GuidedSetupStep.tsx`、`web/src/api/client.ts`、`web/src/i18n/messages.ts`、`GuidedSetupStep.css`：`providerTemplateSupport` 识别读取 `VIBEBATON_MODEL` 的 DSH patch；`effortOptionsFor` / `coerceEffort` 按模型过滤强度（含 Ultra）；强度不支持时显示一句原因；`recommendRoleSpec` 与后端一致；「历史 / 同步」两组合并为「更多可选模型」按 rank 排列；离线内置目录标签同步。
- 测试：`tests/test_model_catalog.py`（+15，改 3 个旧断言）、`tests/test_web_server.py`（+1）、`GuidedSetupStep.test.ts`（+4）。

**决策原因**：
- Gemini 的 `auto` 直接由解析正则排除（只认 `gemini-` 开头的行），比单独给 `auto` 造标签/档位更简单；`auto` 本身不是固定模型。
- Codex 只取 `visibility == "list"` 的条目：本机缓存里 `gpt-reserve`、`codex-auto-review` 都是 `hide`，与 Codex 自己的选择器一致，不写死名单。
- 探测只在同步里做（每日 + 手动强制同步），GET 只读缓存；`sync_model_catalog` 的 `cli_probe` 默认 None（保留旧列表），只有 Studio 的后台线程和手动同步传入真实探测，测试全部注入假数据。缺 `cli_models` 的旧缓存视为过期，升级后立即重抓一次。
- 实测在 Studio 进程里 Gemini CLI 输出带 ANSI 粗体（启动环境带 FORCE_COLOR），解析前先去掉 ANSI 转义；该问题只在真实服务器里出现，命令行直跑看不到。
- `ultra`：`format_command_template` 原样替换 `{effort}`，`resolve_role` 不校验强度，步进阶梯对不认识的强度不加更高档（安全），故可透传；只补了计价剥离后缀。
- 「缺席即下架」只在数据源含该家族行时生效，避免数据源格式变化把整个家族清空；旧测试里「同步后仍保留 gpt-4o」的断言与新需求冲突，已改。
- 下拉分组：合并历史与同步组，才能真正体现「同步与内置统一按版本排序」；`modelGroupSynced` 文案随之删除。
- 放弃：patch yml 里的 GLM-5.3 / GLM-5.2 暂不列入 `dsh_opencode`（会引入新家族，留给用户决定）；DSH 各模型的强度子集（flash: low/high/max，pro: high/max）未过滤。

**验证**：
- 已验证：新测试先失败后通过；后端指定 7 个模块 + `tests.test_pricing` 共 242 个测试通过；前端 vitest 696 通过、`tsc --noEmit` 通过、`npm run build` 成功。
- 已验证（真实数据）：本机 Studio 强制同步后，`gemini_sub` 只剩 Gemini 3.5 Flash / 3.1 Flash Lite / 2.5 Pro，`codex_sub` 10 个（无 reserve / auto-review），GPT-6.2 Sol 强度含 Ultra；引导页 L0 默认变为 `gemini_sub` + Gemini 2.5 Pro 并显示「该 CLI 不支持设置思考强度」，DSH 行模型与强度下拉恢复。
- 未验证：选 Ultra 实际跑一次 Codex 任务。

**commit**：6548e80

## L0004 2026-11-25 头脑风暴「你想做什么」：结构化场景、项目摘要、平实提示词、使用引导页 L0 模型

**目的**：让不熟悉工程的使用者第一条消息就写清结果、对象、边界和完成标准；让模型了解项目概况且不臆造路径；头脑风暴使用引导页选定的 L0 模型。

**改动文件**：
- `src/vibebaton/brainstorm.py`：场景由 5 个扩到 11 个（新增 performance / ui_redesign / dependency_upgrade / write_docs / script_or_data / not_sure），统一用 `_scenario` 生成「开头一句 + 四行提示」；`_SYSTEM_PROMPT` 增补非工程师、主动建议验证命令、不臆造路径、大任务先做第一步四条；新增纯函数 `project_context`（上限 4000 字符）并在 live 路径写入提示词；`_provider_dispatch` 接受 `model_overrides`，先试 L0 选择再按原逻辑；离线草稿跳过未填写的提示行；场景开头不再把整段模板写进 "Starting scenario"。
- `src/vibebaton/web_server.py`：`/api/brainstorm/chat` 接受 `model_overrides` / `role_providers`；把 run start 里同样的校验与合并抽成 `_lineup_overrides` 供两处复用。
- `web/src/components/guided/GuidedBrainstormStep.tsx`、`brainstormScenarios.json`（新）、`GuidedBrainstormStep.css`、`web/src/api/client.ts`、`web/src/i18n/messages.ts`：前端直接 import 场景 JSON；占位文字改为具体示例，输入框上方加一行「写什么最有用」；`sendBrainstormTurn` 附带 lineup 的 L0 选择；输入框加高到 6 行容纳模板。
- 测试：`tests/test_guided_api.py`（+10）、`GuidedBrainstormStep.test.ts`（+2）。

**决策原因**：
- 去重方式：后端 `SCENARIOS` 为准，前端 import 同目录的 JSON 镜像，后端测试断言两者完全相等。放弃新增 GET 接口（首屏会先空再出现场景卡，还要处理加载失败），也放弃让 Vite 直接 import 仓库外的文件（dev server 的 fs.allow 会拦）。
- 四行提示统一为「想达到的结果 / 给谁用、会影响谁 / 不能动的东西 / 怎么算完成」，各场景只换开头一句，模板一致便于离线解析：「不能动」命中现有约束词，命令行能被验证命令提取识别。
- 项目摘要只读 README 前 20 行（跳过 HTML 与徽章行）、根目录与一级子目录的 `package.json` scripts、`pyproject.toml`；目录列表只列名称。跳过 `.git`/`node_modules`/`.baton`/`.venv` 等，名称像 `.env`、credential、secret、token、`*.pem`/`*.key` 的既不列出也不读取。模型仍在临时目录运行。
- L0 传参：前端有显式 `model_overrides` 时只发它，否则发 `role_providers`；后端解析失败（未知供应商）或该供应商未就绪时退回原有的按角色顺序探测；什么都不传时行为不变。
- 提示词避开了反居高临下检查（`CONDESCENDING`）里的词。

**验证**：
- 已验证：后端新测试先失败后通过（「README 跳过徽章 / 相对路径项目名」两条在本机真实运行后补测试再修）；后端指定 7 个模块 238 个测试通过；前端 vitest 698 通过、`tsc --noEmit` 通过、`npm run build` 成功。
- 已验证（真实页面）：本机 Studio 引导页显示 11 个场景卡，点击「Make it faster」填入 5 行模板，提示行显示；点「发送」时请求体带 `model_overrides: {brainstorm_and_final_gate: "gemini_sub:gemini-2.5-pro@medium"}`（用页面内临时桩拦截，未真正调模型）；离线请求返回 200，空提示行未进入草稿。
- 已验证：`project_context` 对本仓库的输出不含敏感文件名，命令检测到 `web/package.json` 的 scripts。
- 未验证：真实模型按新提示词对话的效果（会消耗订阅额度，未调用）；手动步骤：引导页选好团队 → 第 2 步选一个场景 → 只填结果不填验证命令发送，看回复是否主动给出一条命令并解释。

**commit**：b0a04a2
