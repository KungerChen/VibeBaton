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

## 20261126-122618-m2-brainstorm-lock

- 时间：2026-11-26 12:26，America/Los_Angeles。授权：修复 M2 阻塞项并执行指定门禁；分支 `baton/e33e97/ms-m2-r1`，基线 `c7ecca7`，开始时工作区干净。
- 问题与复现：模型派发和就绪扫描期间持有工作区会话锁；新增两项 HTTP 并发测试在修复前均因 GET 在两秒内未返回而失败。
- 施工中：将模型调用和就绪扫描移出锁；重新读取并合并会话，保护并发修改、重置和已保存的在线草稿。首轮两项并发测试及原有扫描失败后保留草稿测试通过；继续补充冲突回归及执行完整门禁。
- 状态：进行中。回退参考为基线 `c7ecca7` 与本轮工作区差异；无新提交。

## 20261126-082838-m2-session-contract


**20261126-082838-m2-session-contract**, 2026-11-26 America/Los_Angeles.
Authorized scope: the five M2-T1 whitelisted paths. The session store,
recommendation types, guide parsing, golden unittest module, and this contract
were added or updated. Recovery reference: pre-task Git revision `45afa42edf56`;
no new commit has been created.

The initial golden test failed because `guided_session` did not yet exist.
On Windows with Python 3.13.2, `python -m unittest tests.test_guided_session
tests.test_guided_api -v` passed all 102 tests. The tests exercised a real child
process exiting during a temporary-file write, injected write and replace
failures, session recovery, guide parsing, and existing local HTTP API behavior.
The new HTTP routes, recommendation policy, Studio integration, and live-model
behavior remain for later milestones. Status: self-tested, awaiting user
acceptance. Next: implement M2-T3/M2-T4 and M3 against this contract. The task
whitelist excludes the project log and index, so this record is kept here.

## 20261126-115602-m2-guided-integration

**20261126-115602-m2-guided-integration**, 2026-11-26 America/Los_Angeles.
The authorized M2-T4 whitelist covers the server, recommendation module,
integration tests and this contract. Added workspace session routes, draft
protection, L0 model discovery, recommendations, panel/lineup preflight and
lineage session transitions.
Explicit lineups are captured with the run; revisions revalidate them. Session
recovery after a post-launch storage failure returns the existing run ID.

The new integration tests first reproduced seven missing-route or unsafe-launch
failures. The M2-R1 through M2-R3 baseline passed 13 tests. The M1 lineage and
supersession suite passed 19 tests; the updated integration suite and the
legacy launch-event compatibility test passed 13 tests. The first required
suite run exposed a Vite build failure because the shared `node_modules` link is
read-only; a subsequent run exposed an extra legacy launch event, which was
removed. The frontend build with `--configLoader runner` passed in a temporary
clone. The final required suite passed 178 tests against an isolated copy with
the then-current source and prebuilt frontend. A full run of that version
executed 943 tests and reported two old panel-test failures: an unregistered
custom CLI was incorrectly considered unavailable, and a legacy test expected a
panel launch without a ready Synthesizer. The former was corrected using the
existing bounded provider probe; its real local CLI end-to-end regression and
the registered-driver authentication guard passed. The latter needs an
authenticated CLI fixture under the new mandatory preflight. The updated
required suite passed all 180 tests in an isolated copy with the prebuilt
frontend. The full suite ran 947 tests successfully, with 4 skipped, in a separate isolated
copy using a test-only authenticated CLI fixture on `PATH`. The suite emitted
subprocess `ResourceWarning` messages. Evidence logs are in the system temporary
directory as `vibebaton-m2-t4-required-last.log` and
`vibebaton-m2-t4-full-fixture.log`.

With the real host `PATH`, the remaining legacy panel test was run directly and
fails with `409` instead of its expected `201`; with the test-only authenticated
CLI it passes. Its fixture is in `tests/test_panel_engine.py`, outside this
task's whitelist. Updating that test to supply a ready Synthesizer scan is
needed for the full suite to pass without the temporary CLI fixture. The new
negative integration test separately proves that a missing Synthesizer
credential creates neither a run nor a daemon.

Status: self-tested, pending user acceptance; the unmodified host full-suite
gate remains open because of the legacy test fixture. A live provider, actual
daemon and Studio interaction have not been exercised. The recovery reference
is pre-task commit `53299ce`; no new commit has been made. The whitelist excludes
`LOG.md` and `LOG-INDEX.md`, so this record is kept here.

## 20261126-123140-m2-gates

- 时间：2026-11-26 12:31，America/Los_Angeles。续 `20261126-122618-m2-brainstorm-lock`。
- 并发回归覆盖模型等待及扫描时的 GET/PUT、新模型选择和运行阶段的合并、并发在线草稿保护、空会话重置后的旧请求失效；冲突返回 `BRAINSTORM_SESSION_CHANGED`。原有扫描失败时保留已完成草稿的测试继续通过。
- 补齐 `tests/test_panel_engine.py` 的已就绪扫描夹具；实际主机环境中该测试由修复前 409 变为 201，整个 panel 模块 8 项通过。配置角色模型包含 `@effort` 时的报告也已增加回归；无后缀时保持原值。
- M2-T1、M2-T4 的历史施工记录原文从 `docs/guided2/session_contract.md` 迁入本日志并建立索引；原文中关于当时 whitelist 的说明保留为历史事实。契约补充并发与 readiness 说明。
- 构建及门禁：`npm run build -- --configLoader runner` 成功；门禁 1：20 项通过；门禁 2：135 项通过；门禁 3：2 项通过。四项完整日志路径为 `%TEMP%/vibebaton-e33e97-m2-r1-gate{1,2,3,4}.log`；门禁 4 正在执行。
- 状态：进行中；无新提交。回退参考为基线 `c7ecca7` 与工作区差异。

## 20261126-123645-m2-scan-stale-response

- 时间：2026-11-26 12:36，America/Los_Angeles。续 `20261126-122618-m2-brainstorm-lock`。
- 复核发现：模型结果保存后仍可能正在扫描 readiness；扫描期间若会话重置或草稿更新，原响应会把旧结果返回页面。扫描结束后增加短暂的会话复核；若草稿或重置状态已改变则返回 409，保留新数据。独立测试覆盖两种情况，并确认扫描期间工作流保存仍可成功。
- 最终代码的门禁 1 已通过 21 项，门禁 3 已通过 2 项；门禁 2 与全量门禁需以最终代码重新执行。日志名称使用 `%TEMP%/vibebaton-e33e97-m2-r1-gate{1,2,3,4}-final.log`。
- 状态：进行中；无新提交。

## 20261126-124814-m2-remediation-verification

- 时间：2026-11-26 12:48，America/Los_Angeles。续 `20261126-122618-m2-brainstorm-lock` 和 `20261126-123645-m2-scan-stale-response`。
- 最终改动：`src/vibebaton/web_server.py` 缩短会话锁范围，在模型返回和 readiness 扫描结束后检查并发草稿修改与重置；较新的工作流、模型选择和运行阶段保留。`tests/test_guided_session_api.py` 覆盖真实本地 HTTP 并发、在线草稿及重置冲突；`tests/test_panel_engine.py` 使用固定就绪扫描；`tests/test_brainstorm_hardening.py` 核验配置模型的可选 effort 后缀。契约补充冲突和 readiness 语义，M2-T1/T4 历史记录已迁入本日志。
- 最终门禁（`PYTHONPATH` 指向本工作树 `src`）：会话 API 21 项通过；头脑风暴、推荐、会话及 Guided API 组合 135 项通过；标准库检查 2 项通过；`python -m unittest discover -s tests` 953 项，949 项通过、4 项跳过，耗时 474.716 秒。日志为 `%TEMP%/vibebaton-e33e97-m2-r1-gate{1,2,3,4}-final.log`。修改前的全量中间版本另通过 952 项、跳过 4 项，不能替代最终门禁。
- 跳过项经单独运行核实：2 项缺 Docker CLI，1 项缺 Windows 目录符号链接权限，1 项本地数据库没有运行记录。全量测试输出子进程 `ResourceWarning`、异步慢任务提示，以及无法读取用户级 Git ignore 文件的警告，退出码为 0。前端 `npm run build -- --configLoader runner` 成功。
- 验证边界：本轮使用本地 HTTP 服务、真实会话存储与测试模型派发，没有调用真实在线模型或执行完整浏览器验收。当前 Studio 蓝图恢复仍使用浏览器本地存储，尚未接入 `/api/guided/session`；服务端会话的 Studio 接入与端到端刷新验收留待后续阶段。推荐类型层次、provider dispatch 的 `assert` 和通用工作区 ignore 模板为本次未处理的非阻塞建议。
- 状态：已自测待用户验收。分支 `baton/e33e97/ms-m2-r1`；无新提交。回退参考为基线 `c7ecca7` 与本轮工作区差异；README 按约定等待用户确认后同步。
- 数量更正：上文中间版本全量门禁为运行 952 项，其中 948 项通过、4 项跳过。

## 20261126-183037-m3-t6-guided-loop

- 时间：2026-11-26 18:30，America/Los_Angeles。目标及授权：在 M3-T6 白名单内接通四阶段 Guided 闭环、服务端会话恢复及集成验证；分支 `baton/e33e97/m3-t6`，基线 `5ecabce`，开始时工作区干净。
- 改动：工作台、蓝图和验收面板共享工作区会话与客户端；恢复四阶段、草稿、工作流和人工门禁，提供重置入口。修订及失败重规划先保存意图并停止父运行，返回蓝图后通过 `request-changes` 创建带修订蓝图的子运行；服务端继承并校验原团队，界面锁定相应控件。恢复不确定的修订响应前核对父运行事件、请求内容和子运行。验收接入血缘加载、合并与三种回退；回退后可继续运行或停止并返回蓝图。重置不会停止已有运行。变更包括 `web/src/components/guided/`、`web/src/i18n/messages.ts`、`docs/guided2/frontend_contract.md` 和 `tests/test_web_fullstack.py`；Pro 画布与节点类型未改动。
- 验证：新跨组件测试覆盖四阶段刷新、重复开工、门禁、失败重规划、两种修订回退、刷新后合并撤销及并发恢复身份检查；真实本地 HTTP 测试覆盖会话、幂等开工、停止、修订、回退、合并和撤销。前端完整测试与构建在工作树使用 `--configLoader runner` 通过，TypeScript 检查通过。原样 npm 命令在工作树因共享 `node_modules/.vite-temp` 只读而报 EPERM；在最终版本的 220 个前端源文件逐个哈希一致、依赖入口可写的隔离副本中，原样测试 865 项及构建通过，副本已清理。
- Python 全量最终复跑 `python -m unittest discover -s tests`：954 项、950 项通过、4 项跳过，472.405 秒，退出码 0。跳过项单独核实为两项缺 Docker CLI、一项缺 Windows 目录符号链接权限、一项本地数据库没有运行记录；输出包含既有 `ResourceWarning` 与用户级 Git ignore 文件权限警告。首轮 Python 全量同为 954 项、跳过 4 项且通过，但启动后补充了全栈合并及撤销断言。最终版本的前一次复跑 954 项、跳过 4 项、1 项失败：白名单外 `tests/test_allocation.py::TestAllocationReport::test_report_without_allocation_events_matches_legacy_bytes` 将实时耗时固定断言为 `0.0s`，当次实际为 `0.1s`；单项原样重跑通过，本轮未改该测试。三次日志分别为 `%TEMP%/vibebaton-m3-t6-python-discovery.log`、`%TEMP%/vibebaton-m3-t6-python-discovery-final.log` 和 `%TEMP%/vibebaton-m3-t6-python-discovery-retry.log`。`python -m vibebaton --version` 输出 1.2.0，8 个预设均为 0 错误、0 警告。`git diff --check` 通过。
- 状态：已自测待用户验收。浏览器连接因当前审批策略不允许而受阻，真实浏览器交互、真实模型和 daemon 端到端运行尚未验证；HTTP 用例使用临时 Git 仓库和模拟 daemon。回退参考为基线 `5ecabce` 与本轮工作区差异；尚无提交。README 和 SPEC 按本轮要求未修改。

## 20261126-211349-workflow-recommendation

- 时间：2026-11-26 21:13（本机时间）。目标及授权：按协作会话转达、用户已确认的方案，修复蓝图步骤"推荐工作流"不随实际情况变化、排版混乱的问题；分支 `fix/workflow-recommendation`，基线 `main` 的 `afd80e7`。
- 原因：`recommend_workflow` 只要有有效的旧团队就整套保留，第一步确认团队后 small/medium/large 完全相同；规模只来自模型的 `guide.size`，离线一律按中型；`preset` 只写日志却参与推荐；panel 只要一个成员就绪就推荐；small 把所有角色（含 L0 终审）换成同一个 eco 模型 `@max`；有备注时正面理由消失；默认型号取 `baton.toml` 而非第一步的分层推荐；推荐区排版拥挤、露原始 `provider:model@effort` 串、用硬编码兜底色。
- 改动（后端）：`src/vibebaton/workflow_recommend.py` 新增纯函数 `estimate_project_size`（Goals 或 Architecture & Deliverables 条目 ≥6 为大；两者都 ≤2 且目录非空为小；其余含空目录、无 Goals 为中）；`recommend_workflow` 新增可选 `size_basis`，团队按规模分档且只用就绪工具：small 用精简团队（L0/L1 保留第一步的推荐，L2/L3 用 L3 性价比模型、思考强度不高于 medium），medium/large 沿用第一步团队（无则用与第一步一致的分层默认），带 `customized: true` 的团队始终保留（`custom_lineup_kept`）；large 仅当汇总模型和所有 panelist 都就绪才推荐 panel，否则 `large_relay` 并给出 `panelist_not_ready` 与 `missing_panelists`；`explanation_codes` 固定为"规模及依据 → 安排（始终出现）→ 备注"，`reason_code` 改为安排代码；`preset` 恒为 `null`。快照改用 `model_catalog.recommend_role_assignment` 构造默认团队与精简团队，删除 `_eco_lineup` 与预设读取。`src/vibebaton/web_server.py`：推荐时模型未给规模则用 `estimate_project_size`（目录只有 `.git/.baton/.gitignore/.gitattributes/README/LICENSE` 视为空）；基础团队依次取手动定制过的 `workflow.lineup`、第一步的 `workflow.guided_selected_lineup`、非空 `workflow.lineup`；就绪快照使用与第一步相同的模型目录。`docs/guided2/session_contract.md` 补充 `customized`、`size`、`guided_selected_lineup` 字段和新的推荐规则。
- 改动（前端）：`GuidedLaunchBar` 改为一张卡片：一句话结论 → 最多三条理由 → 团队表格（角色/工具/型号/思考强度，用 `formatProviderDisplay`、目录型号名、思考强度名；窄栏用容器查询堆叠为每角色两层）→ 专家小组开关（带一句说明、不可用时给出原因、部分专家未就绪时列出名字）→"调整团队"抽屉（表单统一用 `guided-setup__input`/`guided-setup__button`，三列对齐、窄栏单列）→ 开工按钮；颜色全部改用站内 token；首次出现时自动滚动到可见（尊重 `prefers-reduced-motion`）。导出纯函数 `teamRows`、`recommendationHeadline`、`recommendationReasons`、`panelToggleState`。第一步确认团队时带上 `customized`（与分层推荐不同即为 true），蓝图抽屉里改团队也写入 `customized: true`。`messages.ts` 的 m3 文案：`overnight` 改为"自动施工 / Automatic build"，新增结论句、规模用词、新理由，删除不再产生的 `previous_lineup_preserved`、`preset_unavailable`。
- 决策：
  - 手动定制标记：会话和 lineup 里原先没有可用标记（`isLineupCustomized` 只在第一步组件内部用，`size` 标签和保存的 profile 都不能区分"自动推荐后直接确认"），因此新增向后兼容的可选字段 `customized`，缺省视为 false。
  - 默认型号来源：原先无保留团队时 `_host_lineup` 用 `baton.toml` 的角色默认 model；第一步界面用 `buildTieredLineup`（模型目录的 `tier_recommendations`/`role_tiers`）。后端已有与前端镜像的 `model_catalog.recommend_role_assignment`，改为用它按就绪工具构造，并传入与第一步相同的目录缓存；构造失败时才回落到原 `_host_lineup`。
  - panel 启动校验：`panel.py` 对失败的 specialist 记录并跳过，只有全部失败才报错，所以引擎能容忍部分成员缺失；`validate_launch_selection` 保持"至少一个 panelist 就绪"不变，只收紧"推荐"。
  - `preset` 确认只写入 `guided_launch_selection` 事件和会话，没有其他实际效果，所以推荐里恒为 `null`，字段保留兼容。
- 测试改动说明：`tests/test_workflow_recommend_matrix.py` 是旧行为的黄金表，按新规则重写为同样覆盖 60 种组合、断言完整的有序 `explanation_codes`（逐行核对过新结果）；`tests/test_workflow_recommend.py` 中依赖"整套保留"、`preset`、eco `@max`、"一个 panelist 就推荐 panel"、"主机默认 model"的断言按新规则更新并在测试里注明原因；`tests/test_guided_session.py` 的签名断言加入 `size_basis`（见下）；前端 `GuidedLaunchBar.test.ts`、`i18n.test.ts`、`GuidedBrainstormStep.test.ts`（标题文案、用 `role="switch"` 定位开关）相应更新。
- 验证：新增 `tests/test_workflow_recommend_tiers.py`（7 项：三档团队不同、small 的规划/执行分工与思考强度、默认团队与第一步一致、定制团队保留、panel 部分就绪不推荐但可启动、理由顺序、规模估算）和一项 HTTP 测试（估算规模、沿用第一步团队、小项目换精简团队、定制团队保留），先失败后通过。Python 全量 `PYTHONPATH=src VIBEBATON_DISABLE_MODEL_SYNC=1 python -m unittest discover -s tests`：962 项通过、2 项跳过；前端 vitest 874 项、`tsc --noEmit`、`npm run build` 通过。浏览器实测（离线模式、临时演示仓库、1280 宽、中文界面）：走完五问后推荐卡片自动出现在可见区域；结论"这是个中等规模的项目，建议由下面的团队自动施工。"，两条理由，团队表在右侧窄栏中按角色两层显示，无原始标识串、无溢出（修了一处表头在窄栏重新出现、一处"Medium"被截断换行）；在抽屉里改 L0 工具后会话写入 `customized: true`，再发一轮推荐变为"会按你自己定的团队自动施工"。
- 未验证：真实模型给出 `guide.size` 时的路径只有单测；large 且 panel 就绪、panel 部分就绪的界面只在组件测试里覆盖，浏览器里本机没有这种就绪组合；英文界面只在组件测试里看过；工具名仍是 `claude_sub` 这类 provider ID（按要求用 `formatProviderDisplay`，只有 DSH 有友好名）；规模估算把离线问答的回答也计入 Goals 条目，偏向判为中型。
- 状态：已自测待用户验收。提交：后端 `1051813`、前端 `5582872`。README 未修改。

## 20261126-221815-provider-names-launch-card

- 时间：2026-11-26 22:18（本机时间）。目标及授权：按协作会话转达、用户已确认的两处界面改动，只改前端；分支 `feat/provider-names-launch-card-layout`，基线 `main` 的 `7b2362d`。
- 改动：`web/src/i18n/presets.ts` 的 `formatProviderDisplay` 加入内置 provider 显示名（claude_sub→Claude Code、codex_sub→OpenAI Codex、gemini_sub→Gemini CLI、agy_sub→Antigravity CLI、dsh_opencode/dsh_deepseek→DSH、openai_http→OpenAI API、gemini_http→Gemini API），未知 id 原样返回；新增 `formatProviderIdsInText`，把服务器文案中整词出现的内置 id 换成显示名，用于第一步底部的团队说明（后端 `notes_zh/notes_en`）。`<option value>`、提交和会话里的值仍是内部 id。`GuidedBrainstormStep.tsx` 把推荐卡片连同两条与开工相关的 replan 提示移到左侧对话区底部；"开工前请知悉"的假设清单和"还差什么"提示属于蓝图内容，留在右侧蓝图栏。`GuidedLaunchBar` 的专家小组开关与开始按钮合到卡片底部同一行（窄卡片堆叠），"调整团队"每个角色一行、三个选择器成列；表格与抽屉的窄布局断点从 30rem 调到 24rem。`GuidedBrainstormStep.css` 的两栏折叠点从 760px 调到 960px。
- 决策：registry driver 名称只在第一步组件里能拿到，且 provider→driver 是多对一（`dsh_opencode` 同时属于 DSH 与 OpenCode，`openai_http` 属于 Aider/Qwen/Copilot，`gemini_http` 挂在 Gemini CLI 下），所以按简报的后备方案在 `formatProviderDisplay` 里补静态映射，名称与 registry 叫法一致，HTTP 类用"… API"区分。该函数也被专业模式调用（LiveRunPanel、StartRunModal、PreflightStep、LeftSidebar、BatonNode、liveEvents），逐一核对均只用于显示，没有依赖"显示文本等于 id"的逻辑；受影响的只有 6 处断言原始 id 的前端测试（`i18n.test.ts`、`GuidedLaunchBar.test.ts` 3 处、`GuidedSetupStep.test.ts`、`NodeDetailDrawer.test.ts` 2 处），已改为断言显示名。1280 宽时对话列约 500px，原 30rem 断点会让卡片仍走窄布局，因此下调到 24rem；800 宽时两栏下对话列只剩约 200px，因此把两栏折叠点提高到 960px（左侧步骤栏约占 15rem）。
- 验证：前端 vitest 874 项、`tsc --noEmit`、`npm run build` 通过；`tests.test_web_server tests.test_guided_api tests.test_stdlib_only` 162 项通过。新增断言：显示名映射、未知 id 原样、文案替换不误伤 `claude_sub_x`/路径；挂载测试确认卡片位于 `guided-brainstorm__chat` 内。浏览器实测（离线模式、临时演示仓库、中文界面）：1280 宽卡片在对话列下方，表格四列逐行对齐，专家小组与开始按钮同一行、按钮靠右，抽屉三个选择器成列；800 宽变为单栏，卡片在对话下方、蓝图在其后，表格仍四列，无横向滚动、无元素溢出；两种宽度下卡片与工作台文本中无内部 id。截图：`C:\Users\A\AppData\Local\Temp\claude\20073fcf147e5bbc\89b7d710-5c3f-42cd-b438-08dbbe0462af\scratchpad\launch-card-1280.jpg`、`C:\Users\A\AppData\Local\Temp\claude\20073fcf147e5bbc\89b7d710-5c3f-42cd-b438-08dbbe0462af\scratchpad\launch-card-800.jpg`。
- 未验证：第一步底部团队说明的显示名只在单测中验证，浏览器里没有回到第一步看；英文界面只在组件测试中覆盖；24rem 以下（约 680px 以下窗口）的堆叠布局只按 CSS 规则推断，未截图。
- 状态：已自测待用户验收。提交：`0e4c997`。README 未修改。

## 20261126-233025-studio-master-plan

- 时间：2026-11-26 23:30（本机时间）。目的：把 Studio 下一步要执行的全部内容写成一份自包含的文本，供用户和其他 AI 读取；本轮只写文档，不改代码。分支 `main`，基线 `1a135ea`。
- 改动：新增 `docs/STUDIO_MASTER_PLAN.md`，内容为三方（Gemini 4 Carbon、Claude Fable 5.2、GPT-6.2 Astra）两轮协商的终局裁决、执行总顺序、M3 手动验收步骤、目标架构（三幕工作台 + 演练场 Lab）、术语透视镜、界面精简规范、创新特性取舍、Phase 1–4 交付与放行标准、未验证假设和待定事项。
- 决策（用户 2026-11-26 拍板，三项均选 A）：
  - 画布如实更名为演练场 Lab，定位为模拟与配方工具；放弃「另立 RFC 让引擎消费工作流图」，因为引擎从未执行过画布拓扑，改名零后端改动。
  - 先验收 M3，再以该方案为蓝本立新 RFC，然后才动结构；放弃「直接立新 RFC 并入 M3 验收」，避免在未验收的改动上叠加新改动。
  - P0 证据矩阵不改 `schemas.py`，按「有门禁回执 / 仅有改动文件 / 未关联」如实展示；验收项 ID 与门禁外键留到 P1 前单独走 SPEC 讨论，放弃「先改数据模型」，避免 Phase 2 被后端阻塞。
- 为什么放在 `docs/` 而不是只留在线文档：同内容的在线文档是私有的 Claude Docs，其他 AI 工具读不到。
- 验证：未运行应用、测试或构建。文档里的前端行号来自第一轮评审对 `ea85dc3` 的静态阅读，未在 `1a135ea` 上复核；M3 验收步骤中的启动参数经 `python -m vibebaton ui --help` 核对，按钮文案取自 `messages.ts`，未在界面上逐一核对。八条未验证假设列在文档 12.3 节。
- 状态：文档已写，待用户审阅。无提交。README、SPEC（`.baton/00_RFC.md`）和 AGENTS.md 未修改。

## 20261127-0940-small-project-lean-plan

- 时间：2026-11-27（本机时间）。目标及授权：用户确认的"第一档"，让施工规划知道项目规模，小项目少拆任务、不做逐任务审校；分支 `feat/small-project-lean-plan`，基线 `main` 的 `dc2ea0f`。
- 改动：`src/vibebaton/engine.py` 新增 `_guided_project_size`（从 run 的 `guided_launch_selection` 事件读取 `lineup.size`）、`_lean_small_plan`（size=small 时把所有任务的 `reviewer_role` 置为 None；超过 1 个里程碑或 4 个任务时只记 `plan_size_exceeded` 事件，不合并、不删任务）；`_ensure_plan` 仅在 small 时于 RFC 前追加 `## Project Size: small` 约束段（1 个里程碑、至多 4 个任务、`reviewer_role` 为 null、`gate_commands` 含 RFC 验证命令）。`web/src/components/guided/GuidedLaunchBar.tsx` 与 `messages.ts`：small 时在推荐理由后追加一句精简规划说明（`recommendation.smallPlan`，中英文）。
- 决策：规模通道选已有的 `guided_launch_selection` 事件，它在 daemon 启动前写入、修订子 run 也会继承，不改 DB 结构、PlanDAG 结构和引擎流程分支；无该事件的 CLI、专业模式、旧 run 的规划指令逐字不变。说明句放在 `recommendation` 层而不是 `reasons`，因为 `reasons` 需与服务端代码一一对应；small 时不论团队安排都显示，因为精简规划只取决于规模。
- 验证：新增 `tests/test_engine_project_size.py`（指令仅 small 变化、其余逐字相同；small 全流程两个任务通过且未调用 `micro_orchestrator`、里程碑评审仍执行；无规模时逐任务审校照旧；超规模计划照常执行并记事件）与一项 HTTP 测试（引导页启动的规模能被引擎读到），先失败后通过；Python 全量 968 项通过、2 项跳过；前端 vitest 875 项、tsc、build 通过；现有测试未修改。复核会话在合并前于包含 `f336592` 的状态重跑 Python 全量 969 项通过。
- 未验证：真实模型是否遵守规模约束；推荐卡片新增文案未在浏览器实看；修订子 run 继承规模没有单独的端到端测试。
- 状态：已自测待用户验收。提交 `e8d3d13`，已随 `f336592` 合并进 `main` / `dev` 并推送。README 未修改。本条在合并后补记（当时 `LOG.md` 有别处的未提交改动）。

## 20261127-1300-effort-source-of-truth

- 时间：2026-11-27（本机时间）。目标及授权：用户确认的方案，让"工具+型号+思考强度"的可选范围来自实际读到的数据，读不到才用默认，并在所有出口统一校验；分支 `fix/effort-source-of-truth`，基线 `main` 的 `f336592`。起因：用户在推荐团队里看到 `deepseek-v4.1-flash@medium`（该型号没有 medium），排查发现 74 个目录模型中 54 个的档位从未按工具核实，另有 24 处推荐、默认值、预设与保存数据不匹配或无法校验。
- 改动：`model_catalog.py` 按"工具逐模型清单（Codex 缓存、agy models、DSH 配置文件）→ 工具声明（claude --help 的 --effort；Gemini CLI 无强度）→ feed 推理标记（HTTP 与 dsh_deepseek）→ 默认 low/medium/high"给每个模型每个工具写入 `provider_efforts`、`effort_sources`、`provider_defaults`；新增 `normalize_spec` 作为唯一校验，Claude 别名仅用于校验与显示；缓存新增可选键 `cli_declared`、`feed_efforts`，缺这两个键的旧缓存视为过期并立即重新同步；对外的档位推荐新增 `efforts_by_provider`；修正档位推荐（Gemini CLI 不列 Gemini 4、agy 下 hydrogen 改 xhigh、dsh_deepseek 用 v4-flash 等）和越界的默认档位，去掉手写的 DeepSeek 档位。`workflow_recommend.py`：快照带目录；新增 `normalize_lineup`，推荐时校正沿用的团队并给出 `effort_adjusted`，启动校验对不合法档位报 `effort_not_allowed` 并附建议值。`web_server.py`：读取团队档案时自动校正并写回、返回 `corrections`；保存档案时校正；L0 选项和自动选择使用合法默认；同步时探测 Claude 声明的档位。`cli_runner.py`：`dsh_effort_error`，命令加载仓库自带 DSH 配置文件而强度不在该型号档位表里时直接报错、不启动子进程。`specialist_panel` 预设与 `baton.example.toml` 的 `gemini-4-neon-high` 改为 `gemini-4-neon@high`。前端只用后端给的允许档位，工具不支持强度时显示提示，默认来源标"未经核实"，第一步显示一次"已自动改正"。另一提交：小项目团队用两个型号（规划/把关共用 L1 推荐，执行共用 standard 档、强度不高于 high），尊重用户的 L0 选择；团队表合并相同的相邻行。
- 决策：不合法强度取最接近的合法档，等距取较低一档（不擅自加价）；只有强度不在已知顺序里或未写时才退回该工具的合法默认。DSH 配置文件属于仓库数据，在构建目录时直接解析，避免关闭同步时退回默认档。feed 不写值为 false 的标记，缺 `supports_reasoning` 视为不支持强度，避免给 gpt-4o 一类模型发 reasoning_effort。不在 `resolve_role` 校验：config 层无目录，且会让引擎依赖可变的用户缓存；改为在 guided 启动与推荐时校验，专业模式与命令行启动只有 DSH 一道仓库内数据的保护。
- 验证：新增 `tests/test_effort_invariants.py`（档位推荐、默认档位、全部角色 × 全部工具组合、普通与精简团队、所有预设与示例配置；数据齐全、完全无数据、仅 Codex 数据三组夹具），注入旧错误推荐时报错；接口测试覆盖档案校正与一次性提示、启动拒绝与建议值、沿用团队的校正、旧缓存判为过期、小项目沿用 L0 选择。Python 全量 1001 项通过、6 项跳过；前端 vitest 879、tsc、build 通过（执行会话与复核会话各跑一遍）。本机实测：agy 11、codex 10、dsh_opencode 2 来自工具清单，gemini_sub 3 来自工具声明；`flash@medium` → `@low`，`agy_sub:gemini-4-hydrogen@max` → `@xhigh`，`gemini_sub:gemini-2.5-pro@high` → 去掉强度；对外推荐表越界 0 条。
- 未验证：各工具对不合法强度的运行时表现；Claude Code 逐型号差异（`--effort` 帮助文本只到工具级）；前端"未经核实""不支持强度""已自动改正"提示未在浏览器实看；小项目两型号团队的实际运行效果。
- 状态：已自测待用户验收。提交：`ac0196c`、`edb67ac`、`bb6e504`、`d9d5691`、`5025c57`，已合并进 `main` / `dev` 并推送。README 未修改。后续：小任务"一个模型做、一个模型审"的两角色流程需改引擎流程，用户决定留给下一份 RFC。

## 20261127-m3-accepted

- 时间：2026-11-27（本机时间）。事项：用户确认 Guided Mode 2.0 的 M3 验收通过，并指示继续执行《Studio 总体执行方案书》的下一步（步骤 1：新 RFC 立项）。
- 记录范围：用户只给出了"验收通过"的总体结论，没有提供方案书 3.9 表里 A–G 各组的逐项结果；本条不替用户补写分组结论。待定事项 4（验收假绿灯是否算 M3 阻塞项）随验收通过视为不阻塞，其修复仍排在 Phase 1。
- 立项前核实（方案书 12.3 中影响 Phase 1/2 范围的三条假设，读代码核实，未运行）：
  - 假设 5（单次运行的预算覆盖）：不成立。`engine.create_run` 与启动接口只接收 RFC、`mode`、`model_overrides`、`plan_path`、`run_id`、`parent_run_id`；预算只有项目级的 `policies.budget_profile`（`PUT /api/config/budget` 写 `baton.toml`）。发车条按"显示继承值并链接到设置"实现。
  - 假设 7（角色表单能覆盖旧 JSON 覆盖）：基本成立。旧 `StartRunModal` 提交的是 `rfc_markdown`、`mode`、`model_overrides`（角色 → `provider:model@effort` 字符串），与引导侧发车的字段相同；两处都不提供 `interactive` 模式。差别只在旧弹窗可手写任意角色键，表单按已配置角色逐项列出。
  - 假设 1（每次交接有落盘交接物和稳定事件 ID）：部分成立。每次角色调用都写 `prompts/<artifact_key>.md` 与 `out/<artifact_key>.json`，并记一条带自增 ID、`task_id`、`milestone_id` 的 `role_invoked` 事件；但事件里没有 `artifact_key`，事件与交接物只能靠任务与尝试次序推断。Phase 2 的连线卡需要先在事件 payload 里补上该键（纯增量）。
- 改动：本条 LOG；`LOG-INDEX.md` 中 M1–M3 相关条目的状态改为"用户已验收（2026-11-27）"。未改代码。
- 状态：M3 已验收。新 RFC 草稿见 `docs/RFC_STUDIO_WORKBENCH_P1_DRAFT.md`，待用户确认后才写入 `.baton/00_RFC.md`。

## 20261127-rfc-studio-workbench-p1

- 时间：2026-11-27（本机时间）。事项：用户确认新 RFC，写入 `.baton/00_RFC.md`，成为现行目标与验收依据。
- 改动：`.baton/00_RFC.md` 换为《Studio Workbench, Phase 1》（方案书 Phase 1 的发车合一、三幕外壳、两项如实显示，加小任务"一个模型做、一个模型审"的精简流程；三个里程碑、八条验收标准）。原工作区里的 Guided Mode 2.0 RFC 从未提交过（Git 历史里该文件停在 Stage 6），覆盖前归档到 `docs/guided2/RFC_GUIDED_MODE_2.md`。草稿文件 `docs/RFC_STUDIO_WORKBENCH_P1_DRAFT.md` 已并入正式文件后删除。
- 决策：一份 RFC 只做方案书的第一期，Phase 2–4 各自另立，避免在一份 RFC 里堆四期、无法逐期验收；小任务流程只动后端引擎，与前端两个里程碑互不干扰，按用户 2026-11-27 的决定并入本份。小任务保留一次模型评审和最终人工确认，不做单模型直出。单次运行的预算覆盖不做（服务端只有项目级预算）。
- 验证：用 `rfc_checker.check_rfc_readiness` 检查新 RFC，得分 100、无缺失章节、无警告。未运行应用或测试；本轮没有代码改动。
- 状态：RFC 已立项，尚未施工。下一步是里程碑 1（小任务精简流程，后端）。README 未修改。

## 20261127-rfc-roadmap-section

- 时间：2026-11-27（本机时间）。事项：用户问后续各期是否写进了 RFC（此前没有，只在 Non-Goals 里点名），并确认在现行 RFC 末尾加一节路线图。
- 改动：`.baton/00_RFC.md` 末尾追加 `## Roadmap After This RFC (information only)`：Phase 2、3、4 与二期各自的交付、放行标准、立项前必须先定或先核实的事项，以及已砍掉的两项。本期范围、约束、里程碑和八条验收标准未改。
- 决策：路线图只作信息，不进本期范围；章节开头写明规划与执行模型不得据此规划、施工或验收，避免 L1 把后续各期拆进本期计划。各期仍在上一期验收后单独立 RFC，换代前先归档现行 RFC。
- 验证：`rfc_checker.check_rfc_readiness` 得分 100、无警告。未运行应用或测试；没有代码改动。真实规划模型是否会忽略这一节，未验证，里程碑 1 开工后看第一份计划即可确认。
- 状态：已写入，随本条一并提交。README 未修改。
