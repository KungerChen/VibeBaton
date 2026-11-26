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

## L0005 2026-11-25 图标按尺寸从 SVG 渲染；任务栏发糊的原因实测与结论

**目的**：让各尺寸图标边缘清晰、铺满画布；判断 `--app` 窗口任务栏图标发糊能否通过声明或 `WM_SETICON` 解决。

**改动文件**：
- `scripts/render-icons.py`（新）：用本机 Chrome/Edge headless（临时独立 profile）在 canvas 上按 16/24/32/40/48/64/128/192/256/512 每个尺寸分别光栅化 `favicon.svg`，取原始 RGBA 后用标准库编码 PNG（逐行选滤波 + zlib 9）并打包 `favicon.ico`（≤48 用 32 位 BMP 帧，≥64 用 PNG 帧，与原文件布局一致）。≤24 px 用简化图形：去掉 0.18 透明度描边与握把短线，接力棒加粗。
- `web/public/favicon.ico`、`icon-32/48/64/192/256/512.png`：重新生成。
- 未改：`index.html`、`manifest.webmanifest`、`desktop_app.py`、`launch-studio.ps1`。

**决策原因**：
- 本机 Edge headless 的 `--dump-dom` / `--screenshot` 均无输出（退出码 0），Chrome 正常，故脚本依次尝试已安装的 Chromium 浏览器，取第一个返回结果的。
- canvas 直接编码的 PNG 偏大（512 达 272 KB），改为取像素后自行编码，512 降到 49 KB。
- 小尺寸简化依据：并排放大比较 16/24/32，原图在 16/24 时握把变灰斑、细描边让边缘发脏，32 正常，故只在 ≤24 简化。
- 任务栏实测（隔离 profile 启动 `--app` 窗口，用 Win32 `WM_GETICON` 读出图标并导出像素，本机 DPI 216 即 225%）：Chromium 设的 `ICON_BIG` 为 72×72、`ICON_SMALL` 为 36×36，但清晰度远低于同尺寸理想渲染（梯度指标 ~100 对 744），即由 16 dip favicon 放大而来。依次测试「原声明 / 只声明 256 PNG / 只 SVG / 只 ICO / 256+SVG」，新旧图标下结果都一样发糊，所以只调声明无效，声明保持不变。
- `WM_SETICON` 实测：设置后立即读回是清晰的 72×72，但 20 秒后页面标题变化，Chromium 又换回自己的模糊图标。一次性设置无效；要生效需要在窗口存续期间持续重设（后台线程轮询或 WinEvent 钩子），属于更大的行为新增，未实现，留给用户决定。

**验证**：
- 已验证：逐个查看 192/256/512 原图与 16–64（含 ICO 内 BMP/PNG 帧解码后放大 6 倍）拼图，图形铺满、边缘清晰、方向正确；后端指定 7 个模块 238 个测试、前端 vitest 698、`tsc --noEmit`、`npm run build` 全部通过。
- 已知的旧失败：`tests/test_web_fullstack.py` 断言 ICO 帧数为 3，HEAD 上的 ICO 已是 8 帧（f77f397 起），本轮前就失败，未改动。
- 未验证：任务栏的肉眼效果（会话内看不到任务栏）。快捷方式图标引用的是仓库内 `web\public\favicon.ico`，无需重新运行 `-CreateShortcut`；若桌面快捷方式仍显示旧图，运行 `ie4uinit.exe -show` 刷新 Windows 图标缓存。

**commit**：341f9cb

## L0006 2026-11-26 引导模式蓝图：一句话起步、一次一问、清单逐项点亮

**目的**：把引导模式第二步从「11 个场景按钮 + 四栏空模板 + 0–100 就绪度」改成对非工程师友好的对话：一句话起步，AI 每轮只问一个问题并给可点选项，右侧五项清单逐项点亮；实时调用失败不再静默降级。

**改动文件**：
- `src/vibebaton/brainstorm.py`：`BrainstormTurnResult` 新增 `guide`（question / options ≤4 / 五项固定顺序 checklist：what、who、scope、limits、done，状态 clear|assumed|open）与 `error`；系统提示词改为「先复述、只问一个问题、不确定就自己假设并标 assumed、另输出 ```guide JSON 块」，称呼不再用 Lead Architect；解析并校验 guide 块（未知 id 丢弃、缺项补 open、非法状态视为 open、选项截到 4 个并过滤「不确定」类选项），缺失或非法时由 RFC 章节推导保底值；实时失败时仍返回离线结果，但 `error` 给出 ≤200 字符、屏蔽密钥的原因；离线模式按清单顺序逐项提问（中英文固定问题 + 3 个选项），「不确定/你定」类回答记为 assumed 且不写进 RFC；回答了「怎么算完成」时若项目有检测到的测试命令（优先含 test 的）就写入验证块；蓝图「改一下」发来的消息更新对应项而不是当作当前问题的答案；`SCENARIOS` 的 prompt 改为一句自然的示例开场白，删除 `_SCENARIO_FIELDS_*`、`_is_blank_field`、`_offline_reply`。
- `web/src/components/guided/brainstormScenarios.json`：同步新开场白。
- `web/src/components/guided/GuidedBrainstormStep.tsx` / `.css` / `.test.ts`：重写。开场为一个输入框 + 4 个示例（其余收进「更多灵感」），示例不覆盖用户自己写的内容；回复下方显示选项按钮 + 固定「我不确定，你帮我定」；Enter 发送、Shift+Enter 换行、输入法组字时不发送；右侧五项清单（三种状态样式、「已明确 N/5」、每项「改一下」预填并聚焦）、完整文档收进「查看技术文档」；开工前列出 AI 代定的假设，未就绪时用平实语言说明还差什么；`turn.error` 与请求异常都可重试（不重复追加用户消息、不丢输入）；分阶段等待文案；打字机效果（2–4 秒放完、点击立即显示、选项与清单放完后才更新、开关存 localStorage、尊重 prefers-reduced-motion、只播最新一条）；对话按项目路径存 localStorage，可「重新开始」。纯逻辑均导出并单测；删除 `readinessTone`。
- `web/src/components/guided/GuidedWorkbench.tsx`：蓝图步骤也读取工作区路径，并以 `projectPath` 传给蓝图组件。
- `web/src/api/client.ts`（+ `client.test.ts`）：新增 `BrainstormGuide`、`ChecklistItem` 等类型。
- `web/src/i18n/messages.ts`：`guided.brainstorm` 键整体替换，中英文键位一致，EN 仅 ASCII，不出现 RFC / 就绪度 / 交付物。
- `tests/test_guided_api.py`：新增 `BrainstormGuideTests`（合法/缺失/非法/多余 id、guide 在 RFC 前后、离线逐项提问顺序与确定性、双语、已给信息直接点亮、「改一下」、标签与前端文案一致）与失败可见、密钥屏蔽测试；更新场景与响应字段契约。

**决策原因**：
- 「就绪度」量的是章节格式，不是需求是否想清楚，所以清单另起一套 guide 契约；开工条件仍用 `ready_to_launch`（`rfc_checker` 不动）。
- 离线模式判断某项是否已答，用「助手消息里含该项固定问题 → 下一条用户消息即答案」，加上原有句子分类（约束/非目标/命令）；保持同输入同输出。没有选择「每轮记录状态」的方案，因为对话本身就是唯一的状态来源，持久化与重试都更简单。
- 「怎么算完成」回答后自动写入项目已有的测试命令，否则离线用户永远无法开工；只取一条，优先含 test 的。
- 持久化只在发送成功/重新开始时写入，不用 effect 自动保存，避免切换项目时把旧对话写进新项目的键。
- 「改一下」的识别依赖前端文案（`关于「X」，我想改成：` / `About "X", I want to change it to:`），后端有测试校验两边文案一致。
- 多加了一个等待阶段「比平时久一些」（45 秒后），因为真实 CLI 常超过 40 秒。

**验证**：
- 已验证：后端指定 7 个模块 253 个测试通过；前端 vitest 714、`tsc --noEmit`、`npm run build` 通过。浏览器实测（`VIBEBATON_OFFLINE_BRAINSTORM=1`，临时演示仓库，中文界面）：开场与示例、Enter 发送、Shift+Enter 换行、打字机逐字出现且选项在放完后才出现、点击回复立即显示全文、点选项与「我不确定」（清单变为 AI 代你假设并在开工按钮上方列出）、「已明确 N/5」、打字机开关及其刷新后保持、「改一下」预填并聚焦、刷新后对话恢复且不重播、「查看技术文档」、「重新开始」清空本地存储、停掉服务后发送显示错误且输入保留、恢复服务后「重试」成功且用户消息只出现一次、回答完五项后开工按钮可用。实测中发现并修复两个问题：「改一下」消息被离线模式当成当前问题的答案；输入框已有自己的文字时点示例仍会切换场景。
- 未验证：真实模型是否稳定输出 ```guide 块（只有单测覆盖解析与保底）；`turn.error` 的界面提示只在单测/代码层面验证，浏览器里没有构造真实的实时失败；等待阶段文案在离线模式下一闪而过，未肉眼确认；`prefers-reduced-motion` 未实测；英文界面只看了开场页。

**commit**：d7e0a5b（后端契约）、c763ca5（前端重写 + 「改一下」修复）

## L0007 2026-11-26 离线蓝图：没有检查命令前不说「可以开工」；「给谁用」写进 RFC

**目的**：复核发现，空项目（无 package.json / pyproject.toml）离线走完五项后，回复说「可以开工」，但开工按钮是灰的，两者自相矛盾。另外核对「给谁用」是否进了 RFC 正文。

**改动文件**：
- `src/vibebaton/brainstorm.py`：`_offline_turn` 在五项都不再是 open、但 RFC 未达到 `safe_for_overnight` 且没有可识别的验证命令时，追加一个固定问题（中英文各一句），选项为 2–4 条 `rfc_checker` 能识别的命令（项目里检测到并被识别的命令优先，最多 2 条，含 test 的排前，再补 `python -m unittest`、`npm test`、`pytest`）。用户点选或输入命令后命令进入验证块，`done` 项的值变为该命令；回答「不确定」则取第一条并标为 assumed。「可以开工 / start building」的收尾句只在 RFC 真正就绪时出现，否则改为「看看右边的蓝图还差什么」。注入项目命令时也只取 `rfc_checker` 能识别的命令。`_compose_offline_rfc` 新增 `audience` 参数，在 Goals 概述后写一行 `Audience: …`（「不确定」时写默认假设并加 `(assumed)`）。
- `tests/test_guided_api.py`：新增复现测试（中英文两条完整流程、选命令后就绪、「不确定」取第一条）、命令选项排序测试、Audience 写入测试；离线逐项提问测试的结尾断言改为「无命令时继续追问、不说可以开工」。

**决策原因**：
- 不放宽开工门槛、不改 `rfc_checker.py`：由对话补上缺的命令，而不是放宽检查。
- 选项必须是检查器能识别的命令，否则点了之后仍无法就绪，会一直追问；`node --test` 之类不被识别的项目命令因此不进选项。
- 「给谁用」原先在 RFC 里只是 Goals 下一条孤立的 bullet（如 `- 只有我自己`），规划阶段看不出它的含义，所以改为显式的 `Audience:` 一行。只有当回答恰好是固定选项时才去掉那条孤立 bullet；用户自己输入的回答可能还带着别的需求（现有两轮测试即属此类），保留在 Goals 里，避免丢内容。

**验证**：
- 已验证：先写的测试在修复前失败 4 个、报错 1 个，修复后通过；后端指定 7 个模块 256 个测试、前端 vitest 714、`tsc --noEmit`、`npm run build` 全部通过。用复核里的场景（空项目，依次回答四项）直接调用：第五轮回复为检查命令问题、`ready_to_launch=False`；选 `python -m unittest` 后回复「可以开工」、`ready_to_launch=True`，RFC 含 `Audience: 只有我自己`。
- 未验证：本轮没有在浏览器里重走（前端没有改动）；真实模型路径不受影响，未测。
- 已知遗留（未改）：「怎么算完成」的非命令回答（如「我自己打开看一眼就行」）和「改一下」消息本身仍会作为 Goals 的一条 bullet 出现在 RFC 里。

**commit**：856d611

## L0008 2026-11-26 本机没有 Git 身份时，引导页初始化的仓库也能有第一份提交

**目的**：用户机器没有配置全局 `user.name` / `user.email` 时，引导页「开启版本记录」后仓库停在无提交状态（初始提交因 Author identity unknown 失败却被静默忽略），开工后引擎在 `git rev-parse --abbrev-ref HEAD` 处秒挂。

**改动文件**：
- `src/vibebaton/web_server.py`：新增 `_make_first_commit`：`git config user.name` / `user.email` 解析不到时写入仓库级默认身份（`VibeBaton` / `vibebaton@localhost`），已有身份（全局或本地）绝不覆盖，不碰全局配置；随后 `git commit --allow-empty` 做初始提交，不 `git add` 用户文件；失败时返回带 git 简短原因的错误。`_post_workspace_init_git`：新建仓库时不论目录是否为空都做初始提交；「已是仓库但无提交」时不重新 init，直接补身份并提交（`created=False`）；初始提交失败返回 500 而不是 200。`_post_run_start`：仓库是 git 但没有提交时，在保存 RFC、创建运行、启动 daemon 之前返回 400。
- `web/src/components/guided/GuidedSetupStep.tsx`：新增纯函数 `workspaceHistoryState` / `historyAllowsBuild`；沿用原「开启版本记录」的提示行与按钮样式：无提交时显示「这个项目还没有第一份存档，无法开始施工」和「创建第一份存档」按钮（调用同一个 init-git 接口），成功后提示「第一份存档已创建」；版本记录未就绪（非 git 或无提交）时「使用这支团队」按钮禁用，并在旁边说明原因。
- `web/src/i18n/messages.ts`：`guided.setup` 新增 5 个键（中英文一致，EN 仅 ASCII）。
- `tests/test_guided_api.py`：新增 `TestWorkspaceFirstCommit`（用 `GIT_CONFIG_GLOBAL` 指向空文件、`GIT_CONFIG_NOSYSTEM=1` 并去掉测试自带的 `GIT_AUTHOR_*` 环境变量来隔离身份）；`GuidedSetupStep.test.ts` 新增门禁纯逻辑测试。

**决策原因**：
- 身份只写仓库级：不改用户的全局 git 配置；默认身份只在完全解析不到时写入。
- 初始提交用 `--allow-empty` 且不暂存文件：不替用户决定哪些文件进版本库。
- 开工按钮的门禁同时挡住「非 git」和「无提交」，因为两者都会让引擎失败（`has_commits` 对非 git 目录也是 false）。这比原来更严格：以前非 git 目录也能点「使用这支团队」，但开工必失败。
- 后端 400 只针对「是 git 但无提交」：非 git 目录的 start run 行为没改，现有测试用的就是非 git 临时目录，改动面会变大。

**验证**：
- 已验证：新增的 5 个后端测试修复前全部失败、修复后通过；后端指定 7 个模块 261 个测试、前端 vitest 716、`tsc --noEmit`、`npm run build` 全部通过。浏览器实测：以 `GIT_CONFIG_GLOBAL` 指向不存在的文件、`GIT_CONFIG_NOSYSTEM=1` 启动服务，打开一个 `git init` 过但无提交、含一个文件的临时目录：工作区步骤显示「还没有第一份存档」和「创建第一份存档」按钮，「使用这支团队」禁用并说明原因；点修复后提示「第一份存档已创建」，按钮变为可用；仓库里出现作者为 `VibeBaton <vibebaton@localhost>` 的空提交，`git ls-files` 为空，仓库级 `user.name` 为 VibeBaton。
- 未验证：用户实际出问题的 `D:\AI\demo`（按要求未改动）；引擎里任务提交和合并提交（`git_ops.py`）在「仓库已有提交但本机没有身份」时仍会失败，本轮只在 init-git 时补身份，没处理这种情况。

**commit**：61b6880

## 20261126-080223-m1-favicon-gate

- 时间：2026-11-26 08:02，America/Los_Angeles。授权：修复 M1 里程碑的全部阻塞项、增加回归测试并执行四项指定门禁。分支 `baton/e33e97/ms-m1-r1`，基线 `3324a57`；开始时工作区无已跟踪修改。
- 问题：全量测试将 ICO 帧数固定断言为 3，但现有 `web/public/favicon.ico` 为 8 帧；L0005 和 `docs/guided2/lineage_contract.md` 已记录此旧失败。当前工作树独立复现了 `(0, 1, 8) != (0, 1, 3)`。
- 环境：`web/node_modules` 链接到工作区外的共享目录，默认 Vite 构建写临时文件时被沙箱拒绝；`npm run build -- --configLoader runner` 已成功生成工作树内的 `web/dist`。原 `PYTHONPATH` 指向主仓库，验证时必须临时指向当前工作树的 `src`；未调整全局环境或共享依赖。
- 改动：`tests/test_web_fullstack.py` 将固定 3 帧断言改为检查 ICO 头和服务返回的内容与源资源一致；新增独立 HTTP 测试，检查 16/24/32/40/48/64/128/256 像素帧及数据边界，允许额外尺寸。`AGENTS.md` 新增项目入口映射，复用现有 README、RFC、契约和日志，并记录工作树验证方式；`LOG-INDEX.md` 添加本记录索引。
- 阶段验证：`tests.test_web_fullstack` 与 `tests.test_desktop_app` 共 18 项通过；第一项指定门禁 `tests.test_lineage_e2e -v` 6 项通过（57.163 秒），日志位于 `%TEMP%/vibebaton-e33e97-m1-r1-lineage.log`。
- 第二项指定门禁 `tests.test_guided_lineage_api tests.test_guided_api tests.test_web_server -v` 178 项通过（114.755 秒），日志位于 `%TEMP%/vibebaton-e33e97-m1-r1-guided.log`。
- 第三项指定门禁 `tests.test_stdlib_only -v` 2 项通过（0.300 秒），日志位于 `%TEMP%/vibebaton-e33e97-m1-r1-stdlib.log`。
- 第四项指定门禁 `python -m unittest discover -s tests` 运行 874 项（473.468 秒，870 项通过、跳过 4 项），日志位于 `%TEMP%/vibebaton-e33e97-m1-r1-discovery.log`。复核跳过条件：两项缺 Docker CLI，一项因 Windows 无目录符号链接权限，一项因本地数据库没有运行记录。全量测试期间有 Python 子进程 `ResourceWarning`；结束后 22 个警告 PID 中仅一个当前存在，属于系统进程，PID 本身不足以证明与原进程的关系。Git 也报告无法读取用户级 ignore 文件；未影响门禁退出码。
- 交接检查：`git diff --check` 通过；最终工作区仅有 `tests/test_web_fullstack.py`、`LOG.md`、`LOG-INDEX.md` 的修改和新增的 `AGENTS.md`。
- 状态：已自测待用户验收。未进行真实浏览器或实际业务运行验证；本轮没有修改界面或运行时逻辑。回退参考：基线 `3324a57` 与本轮工作区差异，新增的 `AGENTS.md` 为未跟踪文件；尚无新提交。
