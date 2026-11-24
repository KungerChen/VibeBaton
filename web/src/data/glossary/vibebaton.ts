import type { GlossaryEntry } from './types';

// Golden voice for every glossary entry (all six category modules follow it):
// - Address a capable reader who is new to the topic; never talk down.
// - oneLiner: one sentence that names what the thing IS.
// - plainExplain: an everyday analogy, then what it means for the reader's project.
// - proExplain: the precise technical meaning and how VibeBaton relies on it.
// - zh fields are natural Chinese (not word-for-word); keep code identifiers in ASCII.
// - en fields contain no CJK characters; every zh field contains Han characters.
// - related: 2-5 manifest ids worth reading next, never the entry's own id.
export const VIBEBATON_TERMS: GlossaryEntry[] = [
  {
    id: 'rfc',
    term: 'RFC',
    category: 'vibebaton',
    oneLiner_en: 'The written plan that describes what you want built and how to prove it is done.',
    oneLiner_zh: '一份书面方案，写清楚你想做出什么，以及如何证明它已经完成。',
    plainExplain_en:
      'Think of it as the brief you would hand to a team of contractors: the goal, the limits, what is out of scope, and the inspection they must pass. Every AI worker reads the same brief, so a clear RFC is the single biggest factor in getting the result you expect.',
    plainExplain_zh:
      '可以把它看成交给施工队的任务书：目标是什么、有哪些限制、哪些不做，以及最后要通过怎样的验收。所有 AI 执行者读的都是同一份任务书，所以 RFC 写得越清楚，结果就越接近你的预期。',
    proExplain_en:
      'Request for Comments. VibeBaton stores it at `.baton/00_RFC.md` with five required sections: Goals, Constraints, Non-Goals, Architecture & Deliverables, and Verification & Acceptance Criteria. The readiness checker scores it 0-100 and only marks it safe for an unattended run when every section exists and a verification command is present.',
    proExplain_zh:
      'RFC 即 Request for Comments（征求意见稿）。VibeBaton 将其保存在 `.baton/00_RFC.md`，必须包含五个章节：Goals、Constraints、Non-Goals、Architecture & Deliverables、Verification & Acceptance Criteria。就绪度检查器会给出 0-100 分，只有章节齐全且写明验证命令时，才会标记为可无人值守运行。',
    related: ['brainstorm', 'blueprint-card', 'plan-dag', 'acceptance-criteria'],
  },
  {
    id: 'plan-dag',
    term: 'Plan DAG',
    aliases: ['task map', '任务地图'],
    category: 'vibebaton',
    oneLiner_en: 'The task map the planner builds from your RFC, showing which steps depend on which.',
    oneLiner_zh: '规划者根据 RFC 生成的任务地图，标明每一步依赖哪些前置步骤。',
    plainExplain_en:
      'Like a recipe where you must chop the vegetables before you cook them, but can boil water at the same time. The plan lists every step and its prerequisites, so independent steps run in parallel and dependent ones wait their turn.',
    plainExplain_zh:
      '就像做菜：必须先切菜才能下锅，但烧水可以同时进行。这张计划图列出了每一步及其前置条件，互不依赖的步骤并行推进，有依赖的步骤按顺序等待。',
    proExplain_en:
      'A directed acyclic graph of milestones and tasks produced by the planner role. Each task declares its tier, `allowed_paths`, verification command, and `depends_on` edges; the engine schedules any task whose dependencies have passed, up to the concurrency cap, and rejects plans that contain cycles.',
    proExplain_zh:
      '由规划者角色生成的里程碑与任务的有向无环图。每个任务声明自己的层级、`allowed_paths`、验证命令以及 `depends_on` 依赖边；引擎会在并发上限内调度所有依赖已通过的任务，并拒绝含有环的计划。',
    related: ['dag', 'milestone', 'critical-task', 'routine-task', 'rfc'],
  },
  {
    id: 'milestone',
    term: 'Milestone',
    category: 'vibebaton',
    oneLiner_en: 'A checkpoint-sized group of tasks that are reviewed and merged as one unit.',
    oneLiner_zh: '一组围绕同一目标的任务，作为一个整体接受评审并合入集成分支。',
    plainExplain_en:
      'Think of a milestone as one floor of a building: several rooms can be finished in parallel, but the floor is inspected and handed over as a whole before the next stage. Grouping work this way keeps progress visible and limits how much can break at once.',
    plainExplain_zh:
      '可以把里程碑想成建筑中的一层：多个房间可以并行施工，但这一层要整体验收、整体交付，才进入下一阶段。这样既能看清进度，也能把一次出问题的范围控制在一层之内。',
    proExplain_en:
      'A `MilestoneSpec` groups tasks with an id, title, reviewer role, and optional `gate_commands`. Its tasks run on an isolated milestone branch cut from `dev`; when every task passes, the milestone reviewer checks the combined diff and the gate suite before the branch is merged back into `dev`.',
    proExplain_zh:
      '`MilestoneSpec` 把一组任务组织在一起，包含 id、标题、评审角色和可选的 `gate_commands`。其任务从 `dev` 切出的独立里程碑分支上执行；全部任务通过后，里程碑评审者会检查合并后的差异并运行门禁套件，通过后才把该分支合并回 `dev`。',
    related: ['plan-dag', 'gate', 'critical-task', 'dev-branch'],
  },
  {
    id: 'gate',
    term: 'Gate',
    category: 'vibebaton',
    oneLiner_en: 'A checkpoint that must pass before the work behind it can move forward.',
    oneLiner_zh: '一道必须通过的检查点，工作成果只有通过它才能继续向前。',
    plainExplain_en:
      'A gate is the inspection station on an assembly line: work does not advance until the checklist passes, and a failure sends it back with a clear reason. Gates turn a claim of "done" into evidence that the result actually works.',
    plainExplain_zh:
      '门禁就像流水线上的检验站：清单不过，工件就不会进入下一道工序；不通过时会带着明确原因退回。它把“做完了”这一说法变成“确实能跑通”的证据。',
    proExplain_en:
      'A pass or fail boundary in a workflow. A `gate_node` has separate success and failure handles; a task gate runs `verify_cmd`; a milestone gate runs `gate_commands`; a human gate pauses for approval. The engine stops a gate suite on the first failing command and routes the feedback back to the worker.',
    proExplain_zh:
      '工作流中的通过或失败边界。`gate_node` 拥有独立的成功与失败出口；任务门禁运行 `verify_cmd`，里程碑门禁运行 `gate_commands`，人类门禁则暂停等待审批。引擎在门禁命令首次失败时停止整组检查，并把反馈送回执行者。',
    related: ['mechanical-gate', 'final-gate', 'waiting-human', 'acceptance-criteria'],
  },
  {
    id: 'critical-task',
    term: 'Critical Task',
    category: 'vibebaton',
    oneLiner_en: 'A high-stakes task that needs the strongest model and specialist attention.',
    oneLiner_zh: '需要最强模型与专家介入的高风险任务。',
    plainExplain_en:
      'Some work is load-bearing: change an interface or a scheduler incorrectly and many later tasks inherit the damage. A critical task is treated like structural steel, assigned to a senior specialist and checked at the milestone level before it can affect the rest of the build.',
    plainExplain_zh:
      '有些工作是承重结构：接口或调度器改错，后续很多任务都会跟着出问题。关键任务就像钢结构，交给资深专家处理，并在里程碑层面整体检查后，才允许影响其他部分。',
    proExplain_en:
      'A task with `tier: critical` in the Plan DAG. It defaults to the `critical_executor` role, is matched to the highest-priority cost tier the budget profile allows (normally flagship), and defaults to no separate micro-review because its diff is covered by the milestone review. Repeated failures can trigger step-up or escalation.',
    proExplain_zh:
      'Plan DAG 中 `tier: critical` 的任务。默认分配给 `critical_executor` 角色，由分配器匹配旗舰成本档模型；默认不单独做微观评审，而是纳入里程碑评审覆盖其改动。连续失败时会触发升档或升级交接。',
    related: ['routine-task', 'role', 'circuit-breaker', 'milestone'],
  },
  {
    id: 'routine-task',
    term: 'Routine Task',
    category: 'vibebaton',
    oneLiner_en: 'Standard, well-scoped work that parallel bulk workers can complete quickly.',
    oneLiner_zh: '边界清晰、可由多个批量执行者并行完成的常规工作。',
    plainExplain_en:
      'Most of a build is repeatable craft: another API route, another test, another form. Routine tasks are the standard work units handed to fast, economical workers so the expensive specialists stay free for the hard parts.',
    plainExplain_zh:
      '项目里大部分是可重复的工序：再加一个接口、一组测试、一个表单。常规任务就是交给快速、经济的执行者完成的标准化工作单元，让昂贵的专家把精力留给真正的难点。',
    proExplain_en:
      'A task with `tier: routine` in the Plan DAG. It defaults to the `bulk_worker` role with a `micro_orchestrator` reviewer, runs in its own Git worktree, and can be scheduled in parallel up to each provider concurrency cap. The allocator chooses its cost tier from the budget profile, so routine work stays economical unless maximum quality is requested.',
    proExplain_zh:
      'Plan DAG 中 `tier: routine` 的任务。默认分配给 `bulk_worker` 角色，由 `micro_orchestrator` 做微观评审，在独立 Git worktree 中运行，并按各供应方的并发上限并行调度。分配器会依据预算档位优先选择经济或标准成本档模型。',
    related: ['critical-task', 'budget-profile', 'allowed-paths', 'unit-test'],
  },
  {
    id: 'battle-report',
    term: 'Battle Report',
    category: 'vibebaton',
    oneLiner_en: 'A shareable Markdown summary of what a run did, what it cost, and what it caught.',
    oneLiner_zh: '一份可分享的 Markdown 总结，记录运行做了什么、花了多少、拦住了哪些问题。',
    plainExplain_en:
      'After a campaign, a commander wants more than "we won": losses, time, and which defenses held. The battle report is that debrief for a run, generated from recorded events so you can review the evidence before the final gate or share the story publicly.',
    plainExplain_zh:
      '一场战役结束后，指挥者关心的不只是“赢了没有”，还有耗时、代价和哪几道防线真正起了作用。战报就是一次运行的复盘，由事件记录生成，方便你在终审前核对证据，也可以公开分享。',
    proExplain_en:
      'Produced by `baton report` or the Studio report view from SQLite telemetry. It includes status, elapsed time, milestone and task pass counts, gate and whitelist catches, first-pass rate, escalations, cooldown hits, stage timing, per-model calls and runtime, per-task outcomes, and token and USD billing. Reports are localized in English and Chinese.',
    proExplain_zh:
      '由 `baton report` 或 Studio 报告视图基于 SQLite 遥测生成，包含状态、耗时、里程碑与任务通过数、门禁与白名单拦截数、首次通过率、升级次数、冷却命中、阶段耗时、各模型调用与运行时长、逐任务结果，以及 token 与美元账单。报告提供英文和中文两个版本。',
    related: ['milestone', 'circuit-breaker', 'quota-cooldown', 'gate'],
  },
  {
    id: 'waiting-human',
    term: 'Waiting Human',
    aliases: ['Awaiting Your Decision', '等待你的决定', '需要你的决定'],
    category: 'vibebaton',
    oneLiner_en: 'The paused run status that asks you to make a decision before work continues.',
    oneLiner_zh: '一种暂停状态：运行停下来，等你做出决定后再继续。',
    plainExplain_en:
      'Sometimes the responsible move is to stop and ask the owner. When a plan needs changing or a milestone cannot proceed safely, the run parks in Waiting Human instead of guessing, and your answer becomes the next instruction.',
    plainExplain_zh:
      '有时最负责的做法是停下来问项目负责人。当计划需要调整，或某个里程碑无法安全推进时，运行会停在等待人工状态而不是自行猜测，你的决定会成为下一步的指令。',
    proExplain_en:
      'Both a run and a task status (`WAITING_HUMAN`). The engine sets it for `PLAN_AMENDMENT` reviews, blocked human approval points, or merge conflicts it must not auto-resolve. It resumes after a decision is recorded through `baton resolve`, `POST /api/runs/<id>/resolve`, or the Studio decision modal.',
    proExplain_zh:
      '同时是运行状态与任务状态（`WAITING_HUMAN`）。当评审给出 `PLAN_AMENDMENT`、遇到需要人工批准的门禁，或出现不能自动解决的合并冲突时，引擎会进入该状态。通过 `baton resolve`、`POST /api/runs/<id>/resolve` 或 Studio 的决策弹窗记录决定后即可继续。',
    related: ['final-gate', 'sign-off', 'plan-dag', 'human-in-the-loop'],
  },
  {
    id: 'golden-example',
    term: 'Golden Example',
    category: 'vibebaton',
    oneLiner_en: 'An existing file whose conventions a task must copy exactly.',
    oneLiner_zh: '一个现成文件，任务必须严格沿用它体现的写法与结构。',
    plainExplain_en:
      'When several workers must produce matching pieces, a finished sample is clearer than a paragraph of rules. The golden example is that reference piece: same shape, same naming, same handling, so the new work fits alongside it without a second style pass.',
    plainExplain_zh:
      '当多个执行者要产出风格一致的作品时，一件成品样板比一大段规则更清楚。黄金样例就是那件样板：相同的结构、命名和错误处理方式，让新产出无需二次统一就能直接融入。',
    proExplain_en:
      'An optional `golden_example` path on `TaskSpec`. Before dispatch, the engine reads the first 6000 characters of that file inside the task worktree and appends them to the prompt as a fenced reference; if the file is missing, the prompt falls back to a pointer telling the worker to follow its conventions.',
    proExplain_zh:
      '`TaskSpec` 上的可选 `golden_example` 路径。派发任务前，引擎会在任务 worktree 中读取该文件的前 6000 个字符，作为围栏代码块附在提示词里；若文件不存在，则退化为一句指向该路径的说明，要求执行者遵循其约定。',
    related: ['spec', 'routine-task', 'allowed-paths', 'acceptance-criteria'],
  },
  {
    id: 'allowed-paths',
    term: 'Allowed Paths',
    category: 'vibebaton',
    oneLiner_en: 'The file whitelist that bounds where one task may write.',
    oneLiner_zh: '限定单个任务可写文件范围的白名单。',
    plainExplain_en:
      'Give every contractor a defined work area, and a wall painted in the wrong room is obvious immediately. Allowed paths do the same for parallel agents: each task declares its files, and anything outside that boundary is restored before it can be committed.',
    plainExplain_zh:
      '给每位施工者划定明确的作业区，一旦刷错了房间立刻就能发现。允许路径对并行智能体起同样作用：每个任务声明自己的文件范围，越界内容会在提交前被恢复。',
    proExplain_en:
      '`allowed_paths` is a list of glob patterns on `TaskSpec`. After each worker turn, `check_path_whitelist` diffs the worktree against the milestone base; every changed file must match at least one pattern. Violations are reverted or deleted, then the worker retries with the violation as feedback. An empty list disables the guard for that task.',
    proExplain_zh:
      '`allowed_paths` 是 `TaskSpec` 上的 glob 模式列表。每轮执行后，`check_path_whitelist` 会把 worktree 与里程碑基线做差异比较，每个改动文件都必须匹配至少一个模式。越界文件会被恢复或删除，执行者带着违规信息重试。列表为空时该任务不启用此守卫。',
    related: ['worktree', 'sandbox', 'golden-example', 'permission-denied'],
  },
  {
    id: 'baton-backup',
    term: 'Baton Backup',
    category: 'vibebaton',
    oneLiner_en: 'A lightweight Git tag that snapshots the base branch before a run or merge.',
    oneLiner_zh: '运行或合并前，为主分支拍下的轻量 Git 标签快照。',
    plainExplain_en:
      'Before renovating a room, you photograph how it looked. A baton backup is that photo for your base branch: a named tag that makes it possible to return to the exact commit from before the work, without hunting through raw history logs.',
    plainExplain_zh:
      '装修前先给房间拍照存档。baton 备份标签就是主分支的这张照片：一个带名字的标签，记录开工前的确切提交，需要回退时不必在历史记录里逐条翻找。',
    proExplain_en:
      'A lightweight tag named `baton-backup/<run_id>` created on the base branch when a run starts and again immediately before final approval. It is idempotent: an existing tag is kept. `restore_backup_tag` hard-resets the base branch to it, and the Studio rollback action only does so while the approved merge is still the branch head.',
    proExplain_zh:
      '名为 `baton-backup/<run_id>` 的轻量标签，在运行开始时以及最终批准之前创建于主分支。该操作幂等，已存在的标签会保留。`restore_backup_tag` 可把主分支硬重置到该标签；Studio 的回滚操作只在获批合并仍是分支最新提交时执行。',
    related: ['rollback', 'tag', 'dev-branch', 'final-gate'],
  },
  {
    id: 'guided-mode',
    term: 'Guided Mode',
    category: 'vibebaton',
    oneLiner_en: 'The four-step Studio path that carries a project from workspace to sign-off.',
    oneLiner_zh: 'Studio 中从选择工作区到最终验收的四步引导流程。',
    plainExplain_en:
      'Think of a guided checklist that keeps the cockpit simple: choose the project, shape the blueprint, watch the build, and sign off. It presents the same engine and safety gates as Pro mode, but one decision at a time, with the jargon folded away until you open it.',
    plainExplain_zh:
      '可以把它想成一份让驾驶舱保持简洁的引导清单：选项目、打磨蓝图、观看施工、完成验收。它调用的引擎和安全门禁与专业模式完全相同，只是每次只呈现一个决策，术语默认收起，需要时再展开。',
    proExplain_en:
      'A Studio presentation mode persisted in `localStorage`. It has four steps: workspace setup and CLI scan, multi-turn brainstorm ending in a Blueprint Card, live workbench with a node detail drawer and decision modal, and a sign-off panel with approve, revise, and rollback. It is a UI layer over the same REST API and engine used by Pro mode.',
    proExplain_zh:
      '持久化在 `localStorage` 中的 Studio 展示模式，包含四步：工作区选择与 CLI 扫描、以蓝图卡收尾的多轮头脑风暴、带节点详情抽屉与决策弹窗的实时工作台、以及提供批准、修改和回滚的验收面板。它只是 UI 层，底层 REST API 与引擎和专业模式共用。',
    related: ['pro-mode', 'studio', 'blueprint-card', 'sign-off'],
  },
  {
    id: 'pro-mode',
    term: 'Pro Mode',
    category: 'vibebaton',
    oneLiner_en: 'The full Studio workbench, exposing the entire canvas, inspectors, and run controls.',
    oneLiner_zh: 'Studio 的完整工作台，开放全部画布、属性面板与运行控制。',
    plainExplain_en:
      'Pro mode is the open control room rather than the guided checklist: every preset, node, routing field, trace, and diagnostic is available at once. It is the default experience for people who want to inspect or edit the machinery directly, and Guided mode never takes it away.',
    plainExplain_zh:
      '专业模式不是引导清单，而是完全开放的控制室：所有配方、节点、路由字段、轨迹和诊断信息都同时可见。它面向希望直接检查或修改机制的人，是默认体验；进入引导模式也不会取代它。',
    proExplain_en:
      'The default Studio mode, kept fully compatible with existing workflows. It exposes the preset library, node palette, graph validation, edge editing, run launch wizard, live DAG, stage timing, model telemetry, battle report, recipe and case import-export, and final-gate controls. The Guided and Pro switcher only changes presentation, not engine behavior.',
    proExplain_zh:
      'Studio 的默认模式，与既有工作流完全兼容。它开放配方库、节点面板、图校验、连线编辑、启动向导、实时 DAG、阶段耗时、模型遥测、战报、配方与案例导入导出，以及终审控制。引导与专业的切换只改变呈现方式，不改变引擎行为。',
    related: ['guided-mode', 'canvas', 'studio', 'preset'],
  },
  {
    id: 'studio',
    term: 'Studio',
    category: 'vibebaton',
    oneLiner_en: 'The local browser workbench for designing and watching VibeBaton runs.',
    oneLiner_zh: '用于设计并观察 VibeBaton 运行的本地浏览器工作台。',
    plainExplain_en:
      'Studio is the room where the whole relay becomes visible: the workflow on one side, the live run in the middle, and the evidence on the other. You open it locally, so project data stays on your machine while you steer the run.',
    plainExplain_zh:
      'Studio 是把整场接力赛变得可见的工作室：一侧是工作流，中间是实时运行，另一侧是证据与指标。它在本地打开，项目数据留在你的机器上，你在这里指挥运行。',
    proExplain_en:
      'A React single-page app served by `baton ui` on `127.0.0.1`, port 7860 by default, and backed by the stdlib HTTP and SSE server. It renders presets and live Plan DAGs, edits routing, launches runs, surfaces attention states, previews battle reports, and handles final sign-off through the same REST API the CLI uses.',
    proExplain_zh:
      '由 `baton ui` 在 `127.0.0.1`（默认端口 7860）提供服务的 React 单页应用，后端是标准库 HTTP 与 SSE 服务。它渲染配方与实时 Plan DAG、编辑路由、启动运行、呈现需关注状态、预览战报，并通过与 CLI 相同的 REST API 完成最终签收。',
    related: ['canvas', 'guided-mode', 'pro-mode', 'recipe'],
  },
  {
    id: 'canvas',
    term: 'Canvas',
    category: 'vibebaton',
    oneLiner_en: 'The node-and-edge view where a workflow or a live run is visualized.',
    oneLiner_zh: '用节点与连线呈现工作流或实时运行的可视化视图。',
    plainExplain_en:
      'A map makes a complex route understandable at a glance: where work starts, which paths run in parallel, and where it joins. The canvas is that map, with each node showing its current state and each edge showing the handoff.',
    plainExplain_zh:
      '一张地图能让复杂路线一目了然：从哪里开始、哪些路径并行、在哪里汇合。画布就是这张地图，每个节点显示当前状态，每条连线表示一次交接。',
    proExplain_en:
      'A pan-and-zoom node graph rendered from a `WorkflowGraph`. Preset nodes include planner, router, worker, gate, reviewer, merge, and human-gate types; live runs are projected onto the same canvas with status, timing, and animated edge traffic. Clicking a node opens its detail or configuration.',
    proExplain_zh:
      '基于 `WorkflowGraph` 渲染的可平移缩放节点图。预置节点类型包括规划、路由、执行、门禁、评审、合并与人类门禁；实时运行会投影到同一画布上，显示状态、耗时和连线流动动画。点击节点可查看详情或配置。',
    related: ['studio', 'plan-dag', 'preset', 'dag'],
  },
  {
    id: 'preset',
    term: 'Preset',
    category: 'vibebaton',
    oneLiner_en: 'A bundled, validated workflow template you can load onto the canvas.',
    oneLiner_zh: '随应用提供、经过校验、可直接载入画布的工作流模板。',
    plainExplain_en:
      'A preset is a proven recipe in the pantry: a full team layout you can start from instead of building every connection yourself. Load one, adjust a role or two, and launch; the structure has already passed validation.',
    plainExplain_zh:
      '预置配方就像储备好的成熟菜谱：一份完整的团队编排，拿来即可开工，不必从零连接每个节点。载入后调整一两个角色就能启动，其结构已经通过校验。',
    proExplain_en:
      'A `*.baton.json` file under `presets/` that parses into a `WorkflowGraph` and passes `validate_graph`. VibeBaton ships eight, from `starter_2tier` to `flagship_4tier` and `specialist_panel`; each declares difficulty, recommended use, required providers, and cost tier. Studio lists them in Recipe Plaza.',
    proExplain_zh:
      '`presets/` 目录下的 `*.baton.json` 文件，可解析为 `WorkflowGraph` 并通过 `validate_graph` 校验。VibeBaton 内置八个预设，从 `starter_2tier` 到 `flagship_4tier` 与 `specialist_panel`，各自声明难度、适用场景、所需供应方和成本档位。Studio 会在工作流广场列出它们。',
    related: ['recipe', 'canvas', 'lineup', 'budget-profile'],
  },
  {
    id: 'recipe',
    term: 'Recipe',
    category: 'vibebaton',
    oneLiner_en: 'A portable JSON document describing a workflow graph and its model routing.',
    oneLiner_zh: '描述工作流图及其模型路由的可移植 JSON 文档。',
    plainExplain_en:
      'A recipe tells someone how to cook the dish; it does not contain the dinner. Here it records the workflow topology and role routing you can share as a `.baton.json` file or a `#recipe=` link, without any run history or credentials.',
    plainExplain_zh:
      '菜谱只告诉别人怎么做这道菜，并不包含做好的晚餐。这里的配方记录工作流拓扑与角色路由，可通过 `.baton.json` 文件或 `#recipe=` 链接分享，不包含运行历史或凭据。',
    proExplain_en:
      'A serialized `WorkflowGraph`: node types, edges, layout, titles, role and provider assignments, budget profile, and concurrency settings. Studio exports and imports recipes through the same JSON used on the canvas. A recipe has no automatic redaction, so review custom fields before sharing it.',
    proExplain_zh:
      '序列化后的 `WorkflowGraph`：节点类型、连线、布局、标题、角色与供应方分配、预算档位以及并发设置。Studio 通过画布使用的同一份 JSON 导入导出配方。配方不会自动脱敏，分享前需要检查自定义字段。',
    related: ['preset', 'canvas', 'case-bundle', 'studio'],
  },
  {
    id: 'lineup',
    term: 'Lineup',
    category: 'vibebaton',
    oneLiner_en: 'The role-to-provider roster that turns ready tools into a working team.',
    oneLiner_zh: '把本机可用工具编排成团队的角色到供应方分配表。',
    plainExplain_en:
      'A coach cannot field a team until every position has a player. A lineup fills each role with a provider that is actually available on this machine, and it can still form a complete team when only one capable provider is ready.',
    plainExplain_zh:
      '教练要先给每个位置安排球员，球队才能上场。阵容会把每个角色分配给本机真正可用的供应方；即使只有一个可用工具，也能组成一支完整可运行的队伍。',
    proExplain_en:
      '`build_recommended_lineup` maps every configured role to a provider that a ready CLI driver or a present HTTP key can actually run. It preserves a valid configured provider, substitutes the best ready one otherwise, and returns `ready=false` with one next step when nothing is available. Specialist panels also use a member lineup.',
    proExplain_zh:
      '`build_recommended_lineup` 把每个已配置角色映射到真正可运行的供应方：由就绪的 CLI 驱动或已存在的 HTTP 密钥支撑。有效配置会保留，否则替换为最合适的就绪供应方；完全不可用时返回 `ready=false` 并给出唯一推荐的下一步。专家会诊也使用成员阵容。',
    related: ['role', 'provider', 'cli-driver', 'guided-mode'],
  },
  {
    id: 'role',
    term: 'Role',
    matchCase: true,
    category: 'vibebaton',
    oneLiner_en: 'A named job in the relay that maps to a provider, model, and prompt.',
    oneLiner_zh: '接力中的一个具名职责，映射到具体的供应方、模型与提示词。',
    plainExplain_en:
      'A role is a seat at the table, not a person: planner, reviewer, specialist, bulk worker. You can change who fills the seat without rewriting the workflow, which is what lets a plan stay stable while the models underneath evolve.',
    plainExplain_zh:
      '角色是桌上的一个席位，而不是具体某个人：规划者、评审者、专家、批量执行者。你可以更换谁来坐这个席位，而不必重写工作流，因此底层模型变化时计划仍能保持稳定。',
    proExplain_en:
      'A logical job defined under `[roles.<name>]` with `provider`, `model`, optional `prompt_file`, and an ordered `fallback` list. Defaults include `tactical_planner`, `milestone_reviewer`, `micro_orchestrator`, `critical_executor`, and `bulk_worker`; task specs and panel members reference these names rather than hard-coding models.',
    proExplain_zh:
      '在 `[roles.<name>]` 下定义的逻辑职责，包含 `provider`、`model`、可选 `prompt_file` 以及有序的 `fallback` 列表。默认角色包括 `tactical_planner`、`milestone_reviewer`、`micro_orchestrator`、`critical_executor` 与 `bulk_worker`；任务与专家成员引用角色名，而不是硬编码模型。',
    related: ['provider', 'lineup', 'fallback-chain', 'agent'],
  },
  {
    id: 'provider',
    term: 'Provider',
    category: 'vibebaton',
    oneLiner_en: 'A configured CLI or HTTP endpoint that executes prompts for a role.',
    oneLiner_zh: '为角色执行提示词的已配置 CLI 或 HTTP 端点。',
    plainExplain_en:
      'A provider is the phone line to a model rather than the model itself: one line may dial Claude through its CLI, another may reach an OpenAI-compatible API. If a line is busy or rate-limited, VibeBaton can route around it without changing the role.',
    plainExplain_zh:
      '供应方是通往模型的电话线，而不是模型本身：一条线通过 Claude CLI 拨号，另一条可能连接 OpenAI 兼容 API。某条线占线或被限流时，VibeBaton 可以绕开它，而无需改变角色定义。',
    proExplain_en:
      'A `[providers.<name>]` entry. CLI providers declare an argv `command` template, prompt transport, stall and hard timeouts, concurrency, and rate-limit regex; HTTP providers declare `base_url`, `api_key_env`, headers, and optional per-model pricing. Cooldowns and concurrency slots are tracked per provider.',
    proExplain_zh:
      '`[providers.<name>]` 配置项。CLI 供应方声明 argv `command` 模板、提示词传输方式、卡死与硬超时、并发数及限流正则；HTTP 供应方声明 `base_url`、`api_key_env`、请求头和可选的按模型计价。冷却与并发槽按供应方分别跟踪。',
    related: ['role', 'cli-driver', 'quota-cooldown', 'api-key'],
  },
  {
    id: 'cli-driver',
    term: 'CLI Driver',
    category: 'vibebaton',
    oneLiner_en: 'A registry entry describing how to detect, install, sign in, and call a coding CLI.',
    oneLiner_zh: '描述如何检测、安装、登录并调用某个编程 CLI 的注册表条目。',
    plainExplain_en:
      'Different coding tools each speak their own dialect of flags and login flows. A CLI driver is the adapter card for one tool: what binary to look for, how to install it, how to sign in, and how VibeBaton should call it.',
    plainExplain_zh:
      '每种编程工具都有自己的参数与登录方式。CLI 驱动就是某个工具的适配卡：该找哪个可执行文件、如何安装、如何登录，以及 VibeBaton 应以什么方式调用它。',
    proExplain_en:
      'An entry in `presets/cli_registry.json`, loaded by `cli_registry.py`. Each driver carries id, name, tier (`official` or `community`), binary, prerequisites, install and login argv, official URL, command template, provider ids, and environment keys. Install recipes must match an allowlisted prefix.',
    proExplain_zh:
      '`presets/cli_registry.json` 中由 `cli_registry.py` 加载的条目。每个驱动包含 id、名称、层级（`official` 或 `community`）、可执行文件、前置依赖、安装与登录 argv、官网地址、命令模板、供应方 id 和环境变量键。安装命令必须匹配允许列表中的前缀。',
    related: ['provider', 'lineup', 'guided-mode', 'command-not-found'],
  },
  {
    id: 'budget-profile',
    term: 'Budget Profile',
    category: 'vibebaton',
    oneLiner_en: 'The cost-versus-quality setting that steers which model tier each task gets.',
    oneLiner_zh: '控制每个任务分配到哪个模型成本档的“成本与质量”设置。',
    plainExplain_en:
      'A studio can hire a full orchestra for every session or keep a small ensemble for daily work. The budget profile expresses that choice: spend less on standard tasks, keep flagship power for the hard ones, or pay for maximum quality everywhere.',
    plainExplain_zh:
      '工作室可以为每次排练都请整支交响乐团，也可以平时只保留小编制。预算档位表达的就是这种取舍：常规任务少花钱、难点保留旗舰火力，或者处处追求最高质量。',
    proExplain_en:
      '`[policies].budget_profile` with `eco`, `balanced` (default), or `max_quality`. It feeds the allocator: eco prefers eco or standard tiers for routine work, balanced prefers standard for routine and flagship for critical, and max_quality prefers flagship plus higher reasoning effort. With a single ready provider, it adjusts effort instead of switching models.',
    proExplain_zh:
      '`[policies].budget_profile`，可选 `eco`、`balanced`（默认）或 `max_quality`。它驱动分配器：eco 对常规任务优先经济或标准档，balanced 对常规任务优先标准档、对关键任务优先旗舰档，max_quality 则全面优先旗舰档并提高推理强度。只有单一就绪供应方时，它会调整推理强度而不是切换模型。',
    related: ['routine-task', 'critical-task', 'lineup', 'model-routing'],
  },
  {
    id: 'specialist-panel',
    term: 'Specialist Panel',
    category: 'vibebaton',
    oneLiner_en: 'A read-only panel of experts who review the RFC from different perspectives.',
    oneLiner_zh: '从不同视角只读评审 RFC 的专家小组。',
    plainExplain_en:
      'Before construction, a project benefits from a design review with several specialists: one looks at usability, one at structure, one at safety. The panel gathers those independent opinions first, so the plan is challenged before any code is written.',
    plainExplain_zh:
      '开工前，让多位专家做一次设计评审很有价值：有人看可用性，有人看结构，有人看安全。专家会诊先收集这些独立意见，让方案在写第一行代码之前就接受质疑。',
    proExplain_en:
      'Enabled by `--mode panel` or `mode: "panel"`, the run starts with stage `00_PANEL`. Up to `max_concurrency` members review the Master RFC concurrently and read-only; each writes `.baton/runs/<run_id>/panel/<member_id>.md`. Failed members are skipped, and the phase fails only when none succeed or synthesis fails.',
    proExplain_zh:
      '通过 `--mode panel` 或 `mode: "panel"` 启用后，运行会先执行 `00_PANEL` 阶段。最多 `max_concurrency` 位成员以只读方式并发评审 Master RFC，各自写入 `.baton/runs/<run_id>/panel/<member_id>.md`。失败的成员会被跳过；只有全部失败或综合失败时，该阶段才会失败。',
    related: ['synthesizer', 'ai-review', 'rfc', 'role'],
  },
  {
    id: 'synthesizer',
    term: 'Synthesizer',
    category: 'vibebaton',
    oneLiner_en: 'The panel role that merges independent expert reports into one master spec.',
    oneLiner_zh: '把各专家的独立报告合并成一份主规格的会诊角色。',
    plainExplain_en:
      'After several advisors speak, someone must turn the overlapping and conflicting notes into one decision. The synthesizer does that: it reconciles the panel into a single spec, recording the reasoning instead of leaving the planner to guess.',
    plainExplain_zh:
      '几位顾问发言之后，需要有人把重复与冲突的意见整理成一个决定。综合者承担这个工作：把各方观点收敛成一份规格，并保留推理依据，而不是让规划者自行猜测。',
    proExplain_en:
      'The panel role invoked after specialist reports complete, configured by `synthesizer_provider`, `synthesizer_model`, and `synthesizer_prompt_file`. It reads the original RFC plus every member report and writes `.baton/runs/<run_id>/panel/master_spec.md`, which the engine appends to the RFC as input to `01_PLAN`.',
    proExplain_zh:
      '专家报告完成后调用的会诊角色，由 `synthesizer_provider`、`synthesizer_model` 和 `synthesizer_prompt_file` 配置。它读取原始 RFC 与全部成员报告，写出 `.baton/runs/<run_id>/panel/master_spec.md`；引擎会把该文件追加到 RFC 之后，作为 `01_PLAN` 的输入。',
    related: ['specialist-panel', 'rfc', 'plan-dag', 'role'],
  },
  {
    id: 'mechanical-gate',
    term: 'Mechanical Gate',
    category: 'vibebaton',
    oneLiner_en: 'A deterministic command that proves the code builds or passes tests before review.',
    oneLiner_zh: '在评审之前，用确定性命令证明代码能构建或测试通过的门禁。',
    plainExplain_en:
      'Before asking an expensive inspector to judge the work, run the free checklist: does it compile, do the tests pass? A mechanical gate is that checklist. It costs no model tokens and gives an exact pass/fail result and error log when something is wrong.',
    plainExplain_zh:
      '在请昂贵的评审员判断之前，先跑一遍免费清单：能编译吗？测试过了吗？机械门禁就是这份清单。它不消耗模型 token，出问题时给出明确的通过/失败结果和错误日志。',
    proExplain_en:
      'A `verify_cmd` per task or `gate_commands` per milestone, executed by `run_gate_suite` in the relevant task or milestone worktree. Commands run in order, stop at the first non-zero exit, and return stdout, stderr, duration, and exit code. When `machine_gate_before_ai_review` is true and a `verify_cmd` exists, the task cannot reach AI review until it passes; failures feed the self-heal loop.',
    proExplain_zh:
      '任务级的 `verify_cmd` 或里程碑级的 `gate_commands`，由 `run_gate_suite` 在任务 worktree 中执行。命令按序运行，遇到第一个非零退出码即停止，并返回 stdout、stderr、耗时与退出码。当 `machine_gate_before_ai_review` 为真时，任务必须通过门禁才能进入 AI 评审；失败信息会进入自修复循环。',
    related: ['ai-review', 'gate', 'unit-test', 'test-failure'],
  },
  {
    id: 'ai-review',
    term: 'AI Review',
    category: 'vibebaton',
    oneLiner_en: 'An independent model review of the diff against the acceptance criteria.',
    oneLiner_zh: '由独立模型依据验收标准审查代码差异的环节。',
    plainExplain_en:
      'A second pair of eyes is valuable when the first pair did the work. AI review is an independent reviewer that reads the change, the criteria, and the gate results, then returns a verdict; it is a quality check, not a rubber stamp.',
    plainExplain_zh:
      '当第一双眼睛完成了工作，第二双眼睛就很有价值。AI 评审是一个独立评审者，它阅读改动、验收标准和门禁结果后给出结论；这是一次质量检查，而不是盖章走过场。',
    proExplain_en:
      'A separate reviewer role invoked with the diff, acceptance criteria, and gate summary. It returns structured `ReviewVerdict` JSON: `PASS`, `MINOR_FIX`, `MAJOR_REWORK`, or `PLAN_AMENDMENT`, plus blocking issues, nitpicks, confidence, and an optional escalation reason. Unparseable output is treated as `MINOR_FIX`, never as a pass.',
    proExplain_zh:
      '由独立评审角色接收代码差异、验收标准与门禁摘要，返回结构化 `ReviewVerdict` JSON：`PASS`、`MINOR_FIX`、`MAJOR_REWORK` 或 `PLAN_AMENDMENT`，并附带阻塞问题、小建议、置信度和可选的升级原因。无法解析的输出按 `MINOR_FIX` 处理，绝不会视为通过。',
    related: ['mechanical-gate', 'final-gate', 'acceptance-criteria', 'code-review'],
  },
  {
    id: 'final-gate',
    term: 'Final Gate',
    category: 'vibebaton',
    oneLiner_en: 'The human approval that lets a completed run merge from dev into main.',
    oneLiner_zh: '让已完成的运行从 dev 合入 main 的最终人工批准。',
    plainExplain_en:
      'The relay finishes on dev, not on main. The final gate is your last review: read the battle report, inspect the changed files, and decide whether the work lands. Nothing reaches main until you sign it off.',
    plainExplain_zh:
      '接力的终点是 dev，而不是 main。终审门禁是你最后一次把关：读战报、看改动文件，再决定成果是否落地。在你签字之前，任何内容都不会进入 main。',
    proExplain_en:
      'The `READY_FOR_FINAL_GATE` stage reached after every milestone passes and merges into `dev`. It is a human policy point (`final_merge` in `require_human_approval_at`); approval through `POST /api/runs/<id>/finalize` or the Studio sign-off panel merges `dev` into the base branch and records the merge commit and backup tag.',
    proExplain_zh:
      '所有里程碑通过并合入 `dev` 后进入的 `READY_FOR_FINAL_GATE` 阶段。它是人工策略点（`require_human_approval_at` 中的 `final_merge`）；通过 `POST /api/runs/<id>/finalize` 或 Studio 验收面板批准后，才会把 `dev` 合入基础分支，并记录合并提交与备份标签。',
    related: ['sign-off', 'battle-report', 'dev-branch', 'rollback'],
  },
  {
    id: 'sign-off',
    term: 'Sign-Off',
    category: 'vibebaton',
    oneLiner_en: 'Your recorded decision to approve, revise, or roll back a finished run.',
    oneLiner_zh: '你对已完成运行做出的批准、修改或回滚决定，并被记录在案。',
    plainExplain_en:
      'A sign-off is a signature with consequences: approve to land the work, request changes to send it back with notes, or roll back to restore the branch. The panel puts the evidence in front of you first, so the decision is informed rather than assumed.',
    plainExplain_zh:
      '验收就像一份郑重的签字确认：批准让成果落地，要求修改则带着意见退回，回滚则恢复分支。面板会先把证据摆在你面前，让决定建立在事实之上，而不是默认放行。',
    proExplain_en:
      'The Guided sign-off panel calls `POST /api/runs/<id>/finalize` with `approve`, `revise`, or `rollback`. Approve requires `READY_FOR_FINAL_GATE` and a clean working tree; revise requires a note and pauses the run with a revisions file; rollback only undoes its own still-current merge. Every decision is stored as a human event.',
    proExplain_zh:
      '引导模式的验收面板调用 `POST /api/runs/<id>/finalize`，动作为 `approve`、`revise` 或 `rollback`。批准要求运行处于 `READY_FOR_FINAL_GATE` 且工作区干净；要求修改必须附说明，并以修订文件暂停运行；回滚只撤销仍位于分支最新的本次合并。每个决定都会记录为人工事件。',
    related: ['final-gate', 'rollback', 'waiting-human', 'battle-report'],
  },
  {
    id: 'rollback',
    term: 'Rollback',
    category: 'vibebaton',
    oneLiner_en: 'Restoring the base branch to the commit captured before a merge or run.',
    oneLiner_zh: '把主分支恢复到合并或运行之前所记录提交的操作。',
    plainExplain_en:
      'An undo button is only trustworthy if it knows exactly where "before" was. Rollback returns your base branch to the saved snapshot, but it refuses to erase commits that arrived after the merge, so unrelated work is never sacrificed.',
    plainExplain_zh:
      '撤销按钮只有在清楚“之前”在哪里时才可信。回滚会把主分支恢复到已保存的快照，但不会抹掉合并之后出现的其他提交，因此无关工作不会被牺牲。',
    proExplain_en:
      '`restore_backup_tag` checks out the base branch and hard-resets it to `baton-backup/<run_id>`. The Studio finalize rollback is narrower: it requires a `COMPLETED` run with an approved merge, verifies that merge is still the base head, then resets to the recorded `pre_merge_head` and logs the event.',
    proExplain_zh:
      '`restore_backup_tag` 会检出主分支并硬重置到 `baton-backup/<run_id>`。Studio 的 finalize 回滚更严格：要求运行处于 `COMPLETED` 且存在已批准的合并，先确认该合并仍是主分支最新提交，再重置到记录的 `pre_merge_head` 并写入事件日志。',
    related: ['baton-backup', 'sign-off', 'commit', 'final-gate'],
  },
  {
    id: 'circuit-breaker',
    term: 'Circuit Breaker',
    category: 'vibebaton',
    oneLiner_en: 'The escalation rule that stops retrying a failing task and hands it to a specialist.',
    oneLiner_zh: '停止反复重试失败任务、把它交给更强专家的升级规则。',
    plainExplain_en:
      'If a machine keeps tripping the same fuse, you stop resetting it and call an electrician. The circuit breaker does that for a task that fails the gate or review repeatedly: instead of burning the same quota forever, it escalates the work to a stronger rung.',
    plainExplain_zh:
      '如果一台机器反复烧同一根保险丝，就不该继续复位，而应叫电工。熔断器对反复过不了门禁或评审的任务做同样的事：不再无限消耗同一档额度，而是把工作升到更强的层级。',
    proExplain_en:
      'The engine counts self-heal attempts and review rejections against `max_self_heal_attempts` and `max_review_rejects`. When the limit is reached, it calls `compute_step_up_target` to raise effort or switch to a flagship model; if no stronger rung remains, it escalates the task to `escalate_role` (default `critical_executor`) with the failure evidence attached.',
    proExplain_zh:
      '引擎依据 `max_self_heal_attempts` 与 `max_review_rejects` 统计自修复次数和评审拒绝次数。达到上限后，它调用 `compute_step_up_target` 提高推理强度或切换到旗舰模型；若已无更高档位，则把任务升级到 `escalate_role`（默认 `critical_executor`），并附带失败证据。',
    related: ['critical-task', 'ai-review', 'fallback-chain', 'role'],
  },
  {
    id: 'quota-cooldown',
    term: 'Quota Cooldown',
    category: 'vibebaton',
    oneLiner_en: 'A timed pause for one rate-limited provider while other workers keep running.',
    oneLiner_zh: '让某个被限流的供应方定时冷却，同时其他执行者继续工作。',
    plainExplain_en:
      'When one phone line is temporarily blocked, you do not shut the whole office; you wait for that line and use the others. A quota cooldown parks only the provider that returned a rate limit, then retries it after the backoff window.',
    plainExplain_zh:
      '一条电话线暂时占线时，不该让整个办公室停工，而应等待这条线并继续使用其他线路。配额冷却只暂停返回限流的那个供应方，退避窗口结束后自动重试。',
    proExplain_en:
      'When a provider response matches its `rate_limit_regex` or HTTP 429, the engine calls `trigger_provider_cooldown`. The cooldown is stored per provider in SQLite with `cooldown_backoff_sec` steps such as 300, 900, and 1800 seconds; dispatching waits for the remaining time, while sibling providers continue. Repeated hits advance the backoff step.',
    proExplain_zh:
      '当供应方响应命中其 `rate_limit_regex` 或 HTTP 429 时，引擎调用 `trigger_provider_cooldown`。冷却状态按供应方存入 SQLite，并按 `cooldown_backoff_sec`（如 300、900、1800 秒）逐级退避；派发会等待剩余时间，其他供应方照常工作。重复命中会推进退避级别。',
    related: ['fallback-chain', 'provider', 'rate-limit', 'timeout'],
  },
  {
    id: 'fallback-chain',
    term: 'Fallback Chain',
    category: 'vibebaton',
    oneLiner_en: 'The ordered backup providers a role tries when its primary target is unavailable.',
    oneLiner_zh: '主供应方不可用时，角色按顺序尝试的备用供应方列表。',
    plainExplain_en:
      'A good plan names a substitute before the lead is unavailable. The fallback chain is that bench: if the primary model stays throttled, the engine moves to the next configured target instead of failing the task outright.',
    plainExplain_zh:
      '好的计划会在主力缺席之前就安排好替补。回退链就是替补席：主模型持续被限流时，引擎按顺序切换到下一个已配置目标，而不是让任务直接失败。',
    proExplain_en:
      'Each role and panel member can declare `fallback = [{ provider, model }]` in TOML. When a provider stays throttled after the retry budget, the dispatcher walks the chain in order, logs `role_fallback`, and records the model that actually ran. It is distinct from step-up, which raises capability for a failing task.',
    proExplain_zh:
      '每个角色与专家成员都可以在 TOML 中声明 `fallback = [{ provider, model }]`。当供应方在重试预算用尽后仍被限流，调度器按顺序遍历该链，记录 `role_fallback` 事件以及实际执行的模型。它与升档不同：升档针对失败任务提高能力层级。',
    related: ['role', 'quota-cooldown', 'circuit-breaker', 'provider'],
  },
  {
    id: 'daemon',
    term: 'Daemon',
    category: 'vibebaton',
    oneLiner_en: 'The detached background process that executes a run without holding your terminal.',
    oneLiner_zh: '在后台独立执行一次运行、不占用终端的分离进程。',
    plainExplain_en:
      'A long run should not depend on a terminal window staying open. The daemon is the worker you leave behind: it picks up the run, keeps the state in SQLite, and continues even after the window that launched it closes.',
    plainExplain_zh:
      '长时间运行不应依赖终端窗口一直开着。守护进程就是你留在后台的执行者：它接手这次运行，把状态写入 SQLite，即使启动它的窗口关闭也能继续推进。',
    proExplain_en:
      'A detached `python -m vibebaton daemon --run-id <id>` process spawned by `baton run --detach` or a resumed resolve. It runs one `OrchestrationEngine.execute_run` loop, records state and events in SQLite, and exits when the run reaches a terminal or paused status. It is a per-run background worker, not an always-on system service.',
    proExplain_zh:
      '由 `baton run --detach` 或恢复后的 resolve 启动的分离进程 `python -m vibebaton daemon --run-id <id>`。它执行一次 `OrchestrationEngine.execute_run` 循环，把状态与事件写入 SQLite，并在运行到达终态或暂停状态后退出。它是按运行启动的后台工作进程，不是常驻系统服务。',
    related: ['overnight-run', 'waiting-human', 'timeout', 'quota-cooldown'],
  },
  {
    id: 'overnight-run',
    term: 'Overnight Run',
    category: 'vibebaton',
    oneLiner_en: 'An unattended run mode designed to keep working through the night.',
    oneLiner_zh: '为整夜无人值守持续工作而设计的运行模式。',
    plainExplain_en:
      'You brief the team in the evening and review the result in the morning. Overnight mode is built for that rhythm: it keeps going through rate limits and long tasks, records everything, and stops at the human gates instead of making decisions for you.',
    plainExplain_zh:
      '傍晚交代任务，早上查看结果。通宵模式正是为这种节奏设计的：遇到限流和长任务也继续推进，完整记录过程，并在需要人拍板的地方停下来，而不是替你决定。',
    proExplain_en:
      '`--mode overnight` is the default run mode alongside `interactive` and `panel`. It runs without per-step prompts, relies on quota cooldowns and fallbacks to survive rate limits, and still halts at `WAITING_HUMAN` and the final gate. On Windows it can prevent system sleep, and notifications report long cooldowns or completion.',
    proExplain_zh:
      '`--mode overnight` 是默认运行模式，与 `interactive`、`panel` 并列。它没有逐步交互提示，依靠配额冷却与回退链熬过限流，但仍会在 `WAITING_HUMAN` 和终审门禁处停下。在 Windows 上可阻止系统休眠，并通过通知报告长时间冷却或完成状态。',
    related: ['daemon', 'quota-cooldown', 'waiting-human', 'fallback-chain'],
  },
  {
    id: 'dev-branch',
    term: 'Dev Branch',
    category: 'vibebaton',
    oneLiner_en: 'The integration branch where milestones collect before the final gate.',
    oneLiner_zh: '各里程碑在终审之前汇总的集成分支。',
    plainExplain_en:
      'Think of a rehearsal stage in front of the main auditorium. Milestones are merged onto the dev branch as they pass, so the full run can be assembled and tested there while the main branch remains untouched.',
    plainExplain_zh:
      '可以把它想成主会场前面的排练舞台。里程碑通过后逐个合并到 dev 分支，整场运行先在舞台上演练并测试，而主分支始终保持不动。',
    proExplain_en:
      '`[daemon].dev_branch`, `dev` by default. It is created from the base branch if missing. Each milestone branch is cut from and merged back into `dev` after passing its gate and review; when all milestones pass, the run becomes `READY_FOR_FINAL_GATE` and `dev` can be approved into the base branch.',
    proExplain_zh:
      '`[daemon].dev_branch`，默认为 `dev`。若不存在，会从基础分支创建。每个里程碑分支都从 `dev` 切出，通过门禁与评审后再合并回 `dev`；全部里程碑通过后，运行进入 `READY_FOR_FINAL_GATE`，此时可批准把 `dev` 合入基础分支。',
    related: ['milestone', 'final-gate', 'branch', 'worktree'],
  },
  {
    id: 'blueprint-card',
    term: 'Blueprint Card',
    category: 'vibebaton',
    oneLiner_en: 'A compact proposal that summarizes the plan and its readiness before launch.',
    oneLiner_zh: '启动前概括方案与就绪度的精简提案卡片。',
    plainExplain_en:
      'A blueprint card is the one-page summary an architect puts on the table: what we will build, what it touches, how we will know it works, and how ready we are. You can inspect the full RFC behind it, but the card is enough to make the launch decision.',
    plainExplain_zh:
      '蓝图卡就是建筑师放到桌上的一页摘要：要做什么、会动哪些区域、如何验证、准备得怎么样。你可以展开查看背后的完整 RFC，但凭这张卡就足以做出是否开工的决定。',
    proExplain_en:
      'A `BlueprintCard` returned by each brainstorm turn: `title`, `summary`, `deliverables`, `touched_areas`, `verification_plan`, `readiness_score` (0-100), and `ready_to_launch`. Confirming it writes `.baton/00_RFC.md` and reruns `check_rfc_readiness`. It is derived from the RFC draft, not a separate plan.',
    proExplain_zh:
      '每次头脑风暴回合返回的 `BlueprintCard`，包含 `title`、`summary`、`deliverables`、`touched_areas`、`verification_plan`、`readiness_score`（0-100）与 `ready_to_launch`。确认后会写出 `.baton/00_RFC.md` 并重新运行 `check_rfc_readiness`。它由 RFC 草稿派生，不是另一份独立计划。',
    related: ['brainstorm', 'rfc', 'guided-mode', 'acceptance-criteria'],
  },
  {
    id: 'brainstorm',
    term: 'Brainstorm',
    category: 'vibebaton',
    oneLiner_en: 'The guided conversation that turns a plain-language idea into a reviewed RFC draft.',
    oneLiner_zh: '把口语化想法变成可审阅 RFC 草稿的引导式对话。',
    plainExplain_en:
      'You do not need to arrive with a formal specification. Brainstorm is a structured conversation that asks about goals, limits, and proof of completion, then assembles your answers into an RFC while keeping the language human.',
    plainExplain_zh:
      '你不必带着正式规格文档来。头脑风暴是一场有结构的对话，询问目标、边界和完成标准，再把你的回答整理成 RFC，同时保持语言自然易懂。',
    proExplain_en:
      '`brainstorm_turn` supports multi-turn chat, five starter scenarios, and a deterministic offline fallback when no provider is available. It returns a reply, an updated RFC draft, and a Blueprint Card. `confirm_blueprint` writes `.baton/00_RFC.md` and runs the readiness checker. Live dispatch uses the best ready provider.',
    proExplain_zh:
      '`brainstorm_turn` 支持多轮对话、五个起步场景，并在没有可用供应方时提供确定性的离线回退。它返回回复、更新后的 RFC 草稿与蓝图卡。`confirm_blueprint` 会写出 `.baton/00_RFC.md` 并运行就绪度检查。在线派发会选用最合适的就绪供应方。',
    related: ['blueprint-card', 'rfc', 'guided-mode', 'spec'],
  },
  {
    id: 'case-bundle',
    term: 'Case Bundle',
    category: 'vibebaton',
    oneLiner_en: 'A sanitized `.baton-case.json` recording a run for replay and sharing.',
    oneLiner_zh: '为回放与分享而记录的、已脱敏的 `.baton-case.json` 运行档案。',
    plainExplain_en:
      'A case bundle is a flight recorder for one run: the route flown, the events along the way, the outcome, and a checklist confirming sensitive details were scrubbed. Others can replay it in Studio without needing your keys or your machine.',
    plainExplain_zh:
      '案例包是一次运行的飞行记录仪：飞过的路线、沿途事件、结果，以及一份确认敏感信息已清除的检查单。其他人无需你的密钥或机器，就能在 Studio 中回放。',
    proExplain_en:
      'A `baton-case/v1` JSON bundle produced by `baton export-case` with four parts: the sanitized `graph`, ordered `trace` events, run `meta` (status, duration, passes, catches, escalations, models, stages, billing), and a `redaction_report`. CLI export is blocked unless `redaction_report.clean` is true; Studio surfaces the report and disables download, copy, and preview when the audit fails.',
    proExplain_zh:
      '由 `baton export-case` 生成的 `baton-case/v1` JSON 包，包含四部分：脱敏后的 `graph`、按序排列的 `trace` 事件、运行 `meta`（状态、耗时、通过数、拦截数、升级、模型、阶段、账单）以及 `redaction_report`。只有 `redaction_report.clean` 为真时 CLI 才会导出；审计失败时 Studio 会展示报告并禁用下载、复制与预览。',
    related: ['recipe', 'studio', 'battle-report', 'json'],
  },
];
