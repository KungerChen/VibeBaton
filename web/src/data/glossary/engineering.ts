import type { GlossaryEntry } from './types';

export const ENGINEERING_TERMS: GlossaryEntry[] = [
  {
    id: 'unit-test',
    term: 'Unit Test',
    category: 'engineering',
    oneLiner_en: 'A small automated check that one piece of code behaves exactly as intended.',
    oneLiner_zh: '一段小型自动化检查，确认某一小块代码的行为完全符合预期。',
    plainExplain_en:
      'Like testing each light switch in a new house before moving in: you flip one switch and confirm the right lamp turns on. Unit tests run in seconds and tell you precisely which part broke.',
    plainExplain_zh:
      '就像搬进新房前逐个试一遍电灯开关：按下一个开关，确认对应的灯亮了。单元测试几秒钟就能跑完，并且能准确告诉你是哪一部分出了问题。',
    proExplain_en:
      'A test that exercises a single function, class, or module in isolation, replacing slow or external collaborators with mocks or fixtures. VibeBaton verification commands typically run the unit suite (for example `pytest` or `vitest run`), and a failing test sends the task back to its worker.',
    proExplain_zh:
      '在隔离环境中验证单个函数、类或模块的测试，会用 mock 或 fixture 替换缓慢或外部的依赖。VibeBaton 的验证命令通常会运行单元测试套件（例如 `pytest` 或 `vitest run`），只要有测试失败，任务就会退回给执行者。',
    related: ['integration-test', 'mock', 'fixture', 'assertion', 'test-coverage'],
  },
  {
    id: 'integration-test',
    term: 'Integration Test',
    category: 'engineering',
    oneLiner_en: 'An automated check that several parts of the system work correctly together.',
    oneLiner_zh: '一种自动化检查，确认系统的多个部分能够正确地协同工作。',
    plainExplain_en:
      'Every light switch may work on its own, but does the whole circuit hold when the oven and the heater run at once? Integration tests answer that kind of question by connecting real pieces and checking the combined result.',
    plainExplain_zh:
      '每个开关单独测试都没问题，但烤箱和暖气同时开时整条电路还撑得住吗？集成测试回答的就是这类问题：把真实的部件连接起来，检查它们组合后的结果。',
    proExplain_en:
      'A test that runs multiple real components together, such as an HTTP handler with its database or a CLI with the file system, using fakes only at true external boundaries. It is slower than a unit test but catches contract mismatches between modules written by different workers.',
    proExplain_zh:
      '让多个真实组件一起运行的测试，例如 HTTP 处理器连同数据库，或命令行工具连同文件系统，只在真正的外部边界使用替身。它比单元测试慢，但能发现由不同执行者编写的模块之间的契约不一致。',
    related: ['unit-test', 'end-to-end-test', 'contract', 'ci', 'regression'],
  },
  {
    id: 'ci',
    term: 'CI',
    category: 'engineering',
    oneLiner_en: 'Automated checks that run on every change so broken code is caught before it merges.',
    oneLiner_zh: '每次改动都会自动运行的检查，在代码合并前发现破坏。',
    plainExplain_en:
      'Like an inspection lane at the end of an assembly line: every change rolls through the same checks before it can leave the factory. A failure stops there instead of reaching a user.',
    plainExplain_zh:
      '就像装配线末端的质检通道：每个改动都要经过同一套检查才能出厂。不合格的改动会在那里被拦下，而不会交到用户手里。',
    proExplain_en:
      'Continuous Integration: a pipeline that installs dependencies, builds, lints, type-checks, and runs the test suite on each push or pull request. VibeBaton puts those same install, check, and test steps into each task verification command, so what the mechanical gate runs locally matches what CI enforces on the branch.',
    proExplain_zh:
      'Continuous Integration（持续集成）：在每次推送或拉取请求时自动安装依赖、构建、运行 lint、类型检查和测试套件的流水线。VibeBaton 会把同样的安装、检查和测试步骤写进每个任务的验证命令，因此机械门禁在本地执行的内容与 CI 在分支上强制的检查保持一致。',
    related: ['lint', 'type-check', 'build', 'unit-test', 'mechanical-gate'],
  },
  {
    id: 'lint',
    term: 'Lint',
    category: 'engineering',
    oneLiner_en: 'A tool that flags suspicious code patterns and style violations without running the code.',
    oneLiner_zh: '一种不运行代码、只检查可疑写法和风格问题的工具。',
    plainExplain_en:
      'Like a proofreader who marks awkward sentences and typos before a book is printed. Lint does not prove the code works, but it catches dead variables, stray imports, and inconsistent style early, when fixes are cheap.',
    plainExplain_zh:
      '就像书稿付印前的校对员，标出别扭的句子和错别字。Lint 不能证明代码能工作，但能在修复成本还低的时候发现无用变量、多余导入和风格不一致。',
    proExplain_en:
      'Static analysis that parses source into a syntax tree and reports rule violations such as unused imports, shadowed names, or forbidden patterns. VibeBaton runs the linter configured in the repository (for example ESLint or Ruff) as part of verification, and a lint error fails the task just like a failing test.',
    proExplain_zh:
      '把源码解析成语法树并报告规则违规（如未使用的导入、被遮蔽的变量名或禁用写法）的静态分析。VibeBaton 会运行仓库配置的 linter（例如 ESLint 或 Ruff）作为验证的一部分，lint 报错和测试失败一样会让任务不通过。',
    related: ['type-check', 'ci', 'code-review', 'build'],
  },
  {
    id: 'type-check',
    term: 'Type Check',
    category: 'engineering',
    oneLiner_en: 'A compiler pass that verifies values are used consistently with their declared types.',
    oneLiner_zh: '编译器的一次检查，确认每个值都按声明的类型被一致地使用。',
    plainExplain_en:
      'Think of labeled sockets and plugs: a type checker confirms you are not pushing a three-prong plug into a two-hole outlet. It catches whole classes of mistakes before the program ever runs.',
    plainExplain_zh:
      '可以想成带标签的插座和插头：类型检查确认你没有把三脚插头硬塞进两孔插座。它能在程序运行之前就发现一整类错误。',
    proExplain_en:
      'Static verification that every expression matches its expected type, using TypeScript, mypy, or an equivalent checker. The VibeBaton mechanical gate runs `tsc --noEmit` for the web app, so a type error blocks sign-off even when all tests happen to pass.',
    proExplain_zh:
      '使用 TypeScript、mypy 或同类检查器静态验证每个表达式的类型是否符合预期。VibeBaton 的机械门禁会为 Web 应用运行 `tsc --noEmit`，因此即使所有测试碰巧通过，类型错误仍然会阻止签收。',
    related: ['lint', 'ci', 'build', 'type-error', 'typescript'],
  },
  {
    id: 'refactor',
    term: 'Refactor',
    category: 'engineering',
    oneLiner_en: 'A change that improves code structure without changing what the code does.',
    oneLiner_zh: '在不改变代码行为的前提下改进其结构的改动。',
    plainExplain_en:
      'Like reorganizing a kitchen so everything is easier to reach, without changing a single recipe. The food tastes the same; the work just becomes safer and faster. Refactoring is safest when tests pin the current behavior first.',
    plainExplain_zh:
      '就像重新整理厨房，让所有东西都更顺手，但一本菜谱都不改。做出来的菜味道不变，工作却更安全、更高效。先用测试固定住当前行为，重构才最稳妥。',
    proExplain_en:
      'A behavior-preserving transformation such as extracting a function, renaming a variable, or splitting a module. VibeBaton tasks that refactor must run the existing test suite as their verification command, and reviewers reject refactors that quietly change output or error handling.',
    proExplain_zh:
      '保持行为不变的代码变换，例如抽取函数、重命名变量或拆分模块。VibeBaton 中负责重构的任务必须把现有测试套件作为验证命令，评审者也会拒绝那些悄悄改变输出或错误处理的重构。',
    related: ['tech-debt', 'unit-test', 'regression', 'code-review'],
  },
  {
    id: 'tech-debt',
    term: 'Tech Debt',
    category: 'engineering',
    oneLiner_en: 'The accumulated cost of shortcuts in a codebase that make future changes slower.',
    oneLiner_zh: '代码库中因走捷径而积累下来的代价，会让后续改动变慢。',
    plainExplain_en:
      'Like postponing repairs on a house: a taped window is fine today, but every later job takes longer because of it. Some debt is a sensible trade-off; the problem is debt nobody tracks.',
    plainExplain_zh:
      '就像一直拖延房屋维修：用胶带封住的窗户今天还能用，但之后每项工作都会因此更费时。有些“欠账”是合理的取舍，真正的问题是没人记录它们。',
    proExplain_en:
      'The gap between the code you have and the code you would write with unlimited time, including missing tests, duplicated logic, and stale dependencies. VibeBaton keeps debt visible by scoping refactors as explicit tasks rather than letting workers rewrite unrelated code inside feature tasks.',
    proExplain_zh:
      '现有代码与“有无限时间时会写的代码”之间的差距，包括缺失的测试、重复的逻辑和过时的依赖。VibeBaton 把重构拆成明确的任务，而不是让执行者在功能任务里顺手重写无关代码，从而让这些欠账始终可见。',
    related: ['refactor', 'code-review', 'test-coverage', 'dependency'],
  },
  {
    id: 'dag',
    term: 'DAG',
    category: 'engineering',
    oneLiner_en: 'A one-way task map where arrows show order and never loop back to an earlier step.',
    oneLiner_zh: '一张只往前走、绝不绕回起点的单向任务流程图（有向无环图）。',
    plainExplain_en:
      'Think of a family tree or a course syllabus: arrows show what must come before what, and nothing points back to its own ancestor. That "no loops" rule is what lets a scheduler know which tasks are ready right now.',
    plainExplain_zh:
      '可以想成家谱或课程大纲：箭头表示先后顺序，没有任何节点指回自己的祖先。“无环”这条规则正是调度器判断哪些任务现在可以开始运行的依据。',
    proExplain_en:
      'Directed acyclic graph: vertices are tasks and edges encode `depends_on` prerequisites. Every VibeBaton plan is a DAG, and the engine schedules it topologically, refuses to start a task until every dependency passes, and rejects a plan containing a cycle as unexecutable.',
    proExplain_zh:
      '有向无环图：顶点是任务，边表示 `depends_on` 前置条件。VibeBaton 的每份计划都是 DAG，引擎会按拓扑顺序调度它，只有全部依赖通过后才会启动某个任务，并会把含环的计划判定为无法执行。',
    related: ['plan-dag', 'dependency', 'milestone', 'concurrency'],
  },
  {
    id: 'idempotent',
    term: 'Idempotent',
    category: 'engineering',
    oneLiner_en: 'An operation that produces the same result whether you run it once or many times.',
    oneLiner_zh: '无论执行一次还是多次，结果都相同的操作。',
    plainExplain_en:
      'Like pressing the elevator button: pressing it five times still calls the same elevator. Idempotent steps are safe to retry after a crash, because repeating them cannot create duplicates or extra side effects.',
    plainExplain_zh:
      '就像按电梯按钮：按五次仍然只是叫来同一部电梯。幂等步骤可以在崩溃后放心重试，因为重复执行不会产生重复数据或额外的副作用。',
    proExplain_en:
      'A property where `f(f(x)) = f(x)`: a retried request, migration, or file write leaves the system in the same state. The VibeBaton resume logic re-runs interrupted steps, so tasks that create files, branches, or records are expected to check for an existing result before writing again.',
    proExplain_zh:
      '满足 `f(f(x)) = f(x)` 的性质：被重试的请求、迁移或文件写入会让系统停在同一状态。VibeBaton 的恢复逻辑会重新执行被中断的步骤，因此会创建文件、分支或记录的任务必须先在写入前检查已有结果。',
    related: ['atomic-write', 'race-condition', 'backup', 'reset'],
  },
  {
    id: 'atomic-write',
    term: 'Atomic Write',
    category: 'engineering',
    oneLiner_en: 'A file update that either fully succeeds or leaves the previous version untouched.',
    oneLiner_zh: '要么完整成功、要么保持旧版本不变的文件写入方式。',
    plainExplain_en:
      'Like swapping a light bulb in one motion: you never hand someone a half-installed bulb. An atomic write hides the new content until it is complete, so a crash mid-write cannot leave a corrupted file.',
    plainExplain_zh:
      '就像一步就把灯泡换好：绝不会把装了一半的灯泡交到别人手里。原子写入会先把新内容完整准备好再替换，因此写到一半时崩溃也不会留下损坏的文件。',
    proExplain_en:
      'Writing to a temporary file in the same directory, flushing it to disk, then renaming it over the target; rename is atomic on POSIX and NTFS. VibeBaton writes state, manifests, and generated artifacts this way so an interrupted run never leaves a half-written JSON file for the next step to parse.',
    proExplain_zh:
      '先在同一目录写入临时文件，刷盘后再重命名覆盖目标文件；重命名在 POSIX 和 NTFS 上都是原子操作。VibeBaton 用这种方式写状态、清单和生成产物，确保运行中断后不会留下半截 JSON 文件给下一步解析。',
    related: ['idempotent', 'backup', 'race-condition', 'file-locked'],
  },
  {
    id: 'end-to-end-test',
    term: 'End-to-End Test',
    category: 'engineering',
    oneLiner_en: 'An automated check that drives the whole product the way a real user would.',
    oneLiner_zh: '像真实用户一样驱动整个产品的自动化检查。',
    plainExplain_en:
      'Instead of testing the oven, the fridge, and the sink separately, you cook a real meal in the finished kitchen and serve it. End-to-end tests are slow and few, but they catch problems that unit tests cannot see.',
    plainExplain_zh:
      '不是分别测试烤箱、冰箱和水槽，而是在装修好的厨房里真正做一顿饭并端上桌。端到端测试运行慢、数量少，但能发现单元测试看不到的问题。',
    proExplain_en:
      'A test that exercises the full stack, for example launching the web UI against a real server and asserting on the rendered result. VibeBaton reserves them for critical paths such as starting a run and reaching the final gate, because they are slower and more brittle than unit tests.',
    proExplain_zh:
      '覆盖完整链路的测试，例如启动 Web 界面并连接真实服务器，再对渲染结果做断言。由于比单元测试更慢、更脆弱，VibeBaton 只把它们用在启动运行、到达终审门禁等关键路径上。',
    related: ['integration-test', 'unit-test', 'regression', 'critical-task'],
  },
  {
    id: 'regression',
    term: 'Regression',
    category: 'engineering',
    oneLiner_en: 'A bug where a change breaks something that used to work.',
    oneLiner_zh: '某次改动破坏了原本正常的功能而引入的缺陷。',
    plainExplain_en:
      'Like fixing a leaky tap and accidentally shutting off hot water to the whole house. The new work may be correct, but it hurt an existing behavior. A regression test freezes the old behavior so it cannot silently break again.',
    plainExplain_zh:
      '就像修好了漏水的水龙头，却意外切断了整栋楼的热水。新做的工作也许本身没错，却破坏了原本正常的行为。回归测试会固定住旧行为，防止它再次悄悄被破坏。',
    proExplain_en:
      'A defect introduced when previously passing behavior stops working after a change. VibeBaton guards against it by running the affected suite on every task and by keeping the full suite in the mechanical gate, so a regression is attributed to the change that caused it.',
    proExplain_zh:
      '改动之后，原本通过的行为不再工作而引入的缺陷。VibeBaton 要求每个任务都运行受影响的测试套件，并把完整套件放进机械门禁，因此回归缺陷能被归因到真正引入它的那次改动。',
    related: ['unit-test', 'test-coverage', 'mechanical-gate', 'flaky-test'],
  },
  {
    id: 'test-coverage',
    term: 'Test Coverage',
    category: 'engineering',
    oneLiner_en: 'The share of code exercised by the test suite.',
    oneLiner_zh: '测试套件实际执行到的代码所占的比例。',
    plainExplain_en:
      'Like counting which rooms a security guard actually walks through on patrol. Coverage shows where the guard never goes, but not whether they would notice a burglar there. High coverage is a map of blind spots, not proof of quality.',
    plainExplain_zh:
      '就像统计保安巡逻时真正走进过哪些房间。覆盖率能显示哪些地方从未有人去过，却不能说明保安真的能发现那里的入侵者。高覆盖率是一张盲区地图，而不是质量的证明。',
    proExplain_en:
      'The percentage of statements, branches, or lines executed while tests run, reported by tools such as Vitest coverage or pytest-cov. VibeBaton treats coverage as a diagnostic rather than a target: a drop on a critical task warrants review, but a high number does not replace meaningful assertions.',
    proExplain_zh:
      '测试运行时执行到的语句、分支或代码行所占的百分比，由 Vitest coverage 或 pytest-cov 等工具报告。VibeBaton 把覆盖率当作诊断信息而非考核指标：关键任务上覆盖率下降值得复查，但数值再高也不能替代有意义的断言。',
    related: ['unit-test', 'assertion', 'test-failure', 'critical-task'],
  },
  {
    id: 'mock',
    term: 'Mock',
    matchCase: true,
    category: 'engineering',
    oneLiner_en: 'A stand-in object that imitates a real dependency so a test can control its behavior.',
    oneLiner_zh: '在测试中替代真实依赖、并可控制其行为的替身对象。',
    plainExplain_en:
      'Like a flight simulator instead of a real plane: it behaves enough like the real thing to practice, and you can make it rain on demand. Mocks let tests force rare errors without waiting for a real network or database to fail.',
    plainExplain_zh:
      '就像用飞行模拟器代替真飞机：它的行为足够接近真实情况，还能按需制造下雨。Mock 让测试可以强制触发罕见错误，而不必等真实网络或数据库出故障。',
    proExplain_en:
      'A test double that records calls and returns programmed responses, often created with `vi.fn()` or `unittest.mock`. VibeBaton workers must mock true external boundaries such as provider APIs rather than the code under test, so the test still proves the logic works.',
    proExplain_zh:
      '会记录调用并返回预设响应的测试替身，常用 `vi.fn()` 或 `unittest.mock` 创建。VibeBaton 的执行者只能对供应方 API 这类真正的外部边界使用 mock，而不能 mock 被测代码本身，否则测试就无法证明逻辑正确。',
    related: ['fixture', 'unit-test', 'integration-test', 'assertion'],
  },
  {
    id: 'fixture',
    term: 'Fixture',
    category: 'engineering',
    oneLiner_en: 'Reusable setup data or objects that put a test into a known starting state.',
    oneLiner_zh: '可复用的初始数据或对象，把测试置于已知的起始状态。',
    plainExplain_en:
      'Like laying out the same ingredients before each cooking test, so only the technique varies. Fixtures remove randomness from setup; a failure then points at the behavior under test instead of a missing or stale file.',
    plainExplain_zh:
      '就像每次做菜测试前都摆好同样的食材，只让手法变化。Fixture 消除了准备阶段的随机性，这样失败就能指向被测行为，而不是缺失或过期的文件。',
    proExplain_en:
      'Shared setup such as a temporary directory, a sample RFC, or a database row, created before a test and torn down after it. VibeBaton repositories keep fixtures under version control so a test result can be reproduced exactly on another machine or by a reviewer.',
    proExplain_zh:
      '在测试前创建、测试后清理的共享准备内容，例如临时目录、示例 RFC 或数据库记录。VibeBaton 的仓库会把 fixture 纳入版本控制，好让测试结果能在另一台机器上或由评审者精确复现。',
    related: ['mock', 'unit-test', 'integration-test', 'golden-example'],
  },
  {
    id: 'assertion',
    term: 'Assertion',
    category: 'engineering',
    oneLiner_en: 'A statement in a test that declares what the result must be.',
    oneLiner_zh: '测试中声明结果必须是什么的语句。',
    plainExplain_en:
      'Like writing down the expected weight before stepping on the scale: without that number, the scale reading means nothing. Assertions turn a test from "the code ran" into "the code produced the right answer."',
    plainExplain_zh:
      '就像在站上体重秤前先写下预期数值：没有这个数，秤上的读数说明不了什么。断言把测试从“代码跑起来了”变成“代码给出了正确答案”。',
    proExplain_en:
      'A check such as `expect(value).toBe(42)` that fails the test when the actual result differs from the expected one. VibeBaton tests assert on observable behavior, and a task is only done when its verification command exits zero because every assertion held.',
    proExplain_zh:
      '例如 `expect(value).toBe(42)` 这样的检查：实际结果与预期不符时会让测试失败。VibeBaton 的测试针对可观测行为做断言，只有验证命令以零退出码结束、所有断言都成立，任务才算完成。',
    related: ['unit-test', 'test-coverage', 'test-failure', 'acceptance-criteria'],
  },
  {
    id: 'build',
    term: 'Build',
    matchCase: true,
    category: 'engineering',
    oneLiner_en: 'The process that turns source files into a runnable or deployable artifact.',
    oneLiner_zh: '把源文件转换成可运行或可部署产物的过程。',
    plainExplain_en:
      'Like assembling flat-pack furniture from the parts in the box: the source is complete, but you still have to put it together before anyone can use it. A build also reveals missing pieces that a quick test run might skip.',
    plainExplain_zh:
      '就像把箱子里的零件组装成家具：源代码是齐全的，但要真正能用还得先拼起来。构建还能暴露那些快速跑测试时可能被跳过的缺失部分。',
    proExplain_en:
      'Compilation, bundling, and asset generation that produce the output users run, for example `vite build` or `npm run build`. VibeBaton includes a build step in verification when the change affects shipping output, because code can pass tests and still fail to bundle.',
    proExplain_zh:
      '通过编译、打包和资源生成来产出一份用户可运行的输出，例如 `vite build` 或 `npm run build`。当改动影响最终交付物时，VibeBaton 会把构建步骤纳入验证，因为代码可能通过测试却无法完成打包。',
    related: ['ci', 'dependency', 'package-manager', 'deployment'],
  },
  {
    id: 'dependency',
    term: 'Dependency',
    category: 'engineering',
    oneLiner_en: 'An external package or module that a project relies on to work.',
    oneLiner_zh: '项目运行所依赖的外部包或模块。',
    plainExplain_en:
      'Like the parts a workshop buys from suppliers instead of making itself: screws, hinges, and motors. You depend on those parts arriving in the expected condition, and a changed supplier can break your own product.',
    plainExplain_zh:
      '就像车间从供应商那里采购而不自己制造的零件：螺丝、铰链和电机。你依赖这些零件以预期状态到货，而供应商一旦换了，你自己的产品也可能出问题。',
    proExplain_en:
      'A library listed in `package.json`, `pyproject.toml`, or another manifest and resolved through the lockfile. VibeBaton avoids adding new dependencies for a task unless the RFC calls for them, because every dependency increases supply-chain, licensing, and build risk.',
    proExplain_zh:
      '列在 `package.json`、`pyproject.toml` 或其他清单中，并通过锁文件解析的库。除非 RFC 明确要求，VibeBaton 会避免为任务新增依赖，因为每个依赖都会增加供应链、许可证和构建风险。',
    related: ['package-manager', 'lockfile', 'semver', 'dependency-conflict'],
  },
  {
    id: 'package-manager',
    term: 'Package Manager',
    category: 'engineering',
    oneLiner_en: 'A tool that downloads, installs, and records the libraries a project needs.',
    oneLiner_zh: '负责下载、安装并记录项目所需库的工具。',
    plainExplain_en:
      'Like a grocery delivery service that both fetches every ingredient and writes down exactly which brand and size you received. The recorded list is what lets another kitchen reproduce the same dish next month.',
    plainExplain_zh:
      '就像既负责采购所有食材、又记下每个品牌和规格的送货服务。正是这份记录，让另一个厨房下个月也能做出同样的菜。',
    proExplain_en:
      'A tool such as npm, pnpm, pip, or uv that resolves version constraints and installs packages. The VibeBaton setup steps use the package manager declared by the repository and run the matching locked install, so verification starts from the same dependency set the author used.',
    proExplain_zh:
      'npm、pnpm、pip 或 uv 这类解析版本约束并安装包的工具。VibeBaton 的初始化步骤会使用仓库声明的包管理器并执行对应的锁定安装，从而让验证从作者所用的同一套依赖开始。',
    related: ['dependency', 'lockfile', 'semver', 'monorepo'],
  },
  {
    id: 'lockfile',
    term: 'Lockfile',
    category: 'engineering',
    oneLiner_en: 'A generated file that pins the exact version of every installed dependency.',
    oneLiner_zh: '自动生成、锁定每个已安装依赖确切版本的文件。',
    plainExplain_en:
      'Like a receipt that lists the exact batch and model of every part used, not just "a hinge." A lockfile lets a coworker rebuild your project with identical parts, so "works on my machine" stops being a mystery.',
    plainExplain_zh:
      '就像一张收据，写明每个零件的确切批次和型号，而不只是“一个铰链”。锁文件让同事能用完全相同的零件重建你的项目，“在我机器上是好的”就不再是谜。',
    proExplain_en:
      'A file such as `package-lock.json`, `pnpm-lock.yaml`, `poetry.lock`, or `uv.lock` recording resolved versions and integrity hashes. VibeBaton installs with the locked mode (`npm ci`, `pnpm install --frozen-lockfile`, `uv sync --locked`) and expects the lockfile to be committed whenever the manifest changes.',
    proExplain_zh:
      '记录解析后的版本和完整性哈希的文件，例如 `package-lock.json`、`pnpm-lock.yaml`、`poetry.lock` 或 `uv.lock`。VibeBaton 会用锁定模式安装（`npm ci`、`pnpm install --frozen-lockfile`、`uv sync --locked`），并要求清单变化时同步提交锁文件。',
    related: ['package-manager', 'dependency', 'semver', 'build'],
  },
  {
    id: 'semver',
    term: 'Semver',
    category: 'engineering',
    oneLiner_en: 'A three-number versioning scheme where each part signals the size of a change.',
    oneLiner_zh: '用三个数字表示版本、每个数字代表不同改动规模的版本方案。',
    plainExplain_en:
      'MAJOR.MINOR.PATCH works like traffic signals for upgrades: a major bump means the rules changed, a minor bump adds something compatible, and a patch fixes something quietly. It tells you how much care an upgrade needs before you read any changelog.',
    plainExplain_zh:
      'MAJOR.MINOR.PATCH 就像升级时的红绿灯：主版本号跳变意味着规则变了，次版本号表示新增了兼容功能，修订号则是悄悄修复问题。它让你在读更新日志之前，就知道这次升级需要多谨慎。',
    proExplain_en:
      'Semantic Versioning: `MAJOR.MINOR.PATCH`, with a major increment for breaking changes, minor for backward-compatible features, and patch for fixes. npm and pip ranges rely on these promises, which is why VibeBaton pins or locks versions instead of assuming an upgrade is harmless.',
    proExplain_zh:
      '语义化版本：`MAJOR.MINOR.PATCH`，破坏性改动提升主版本号，向后兼容的新功能提升次版本号，修复提升修订号。npm 和 pip 的版本范围依赖这些承诺，因此 VibeBaton 会锁定版本，而不是假设升级一定无害。',
    related: ['dependency', 'lockfile', 'version-mismatch', 'package-manager'],
  },
  {
    id: 'monorepo',
    term: 'Monorepo',
    category: 'engineering',
    oneLiner_en: 'A single repository that contains several projects or packages.',
    oneLiner_zh: '在同一个仓库中容纳多个项目或包的代码组织方式。',
    plainExplain_en:
      'Like one large workshop with separate rooms for carpentry, wiring, and painting, sharing the same power and tool room. Changes can span rooms in one commit, but a shared mistake can affect every room at once.',
    plainExplain_zh:
      '就像一个大型车间，木工、布线、喷漆各有房间，却共用同一套电力和工具间。改动能在一个提交里跨房间完成，但一个共同的错误也可能同时影响所有房间。',
    proExplain_en:
      'One repository holding multiple packages, often managed by npm workspaces, pnpm workspaces, or Turborepo. VibeBaton respects the verification command of each package and scopes the `allowed_paths` of a task to the affected package, so a change to one app does not silently rewrite another.',
    proExplain_zh:
      '在一个仓库中承载多个包，常用 npm workspaces、pnpm workspaces 或 Turborepo 管理。VibeBaton 会尊重各包自己的验证命令，并把任务的 `allowed_paths` 限制在受影响的包内，避免改一个应用时悄悄重写另一个。',
    related: ['repository', 'module', 'dependency', 'allowed-paths'],
  },
  {
    id: 'module',
    term: 'Module',
    category: 'engineering',
    oneLiner_en: 'A self-contained file or package that exposes a small, deliberate public surface.',
    oneLiner_zh: '一个自包含的文件或包，只暴露少量有意设计的公开接口。',
    plainExplain_en:
      'Like a drawer with a labeled handle: you pull the handle to get what you need and never reach into the internal compartments. Modules keep complexity behind a known door instead of scattering it through the project.',
    plainExplain_zh:
      '就像带标签把手的抽屉：你拉把手取需要的东西，而不必把手伸进抽屉内部乱翻。模块把复杂性挡在一扇熟悉的门后，而不是任其散布到整个项目。',
    proExplain_en:
      'A unit of code with its own scope and exports, such as one TypeScript file or one Python package. VibeBaton tasks are scoped to keep module boundaries intact; if a change needs to reach across many modules, the plan should show why rather than letting a worker edit everything it can see.',
    proExplain_zh:
      '拥有独立作用域和导出的代码单元，例如一个 TypeScript 文件或一个 Python 包。VibeBaton 的任务范围会尽量保持模块边界完整；如果改动需要横跨多个模块，计划中应当说明原因，而不是让执行者随意编辑所有能看到的文件。',
    related: ['interface', 'dependency', 'monorepo', 'contract'],
  },
  {
    id: 'interface',
    term: 'Interface',
    matchCase: true,
    category: 'engineering',
    oneLiner_en: 'The agreed boundary through which one part of a system can be used by another.',
    oneLiner_zh: '系统的一部分可被另一部分使用的约定边界。',
    plainExplain_en:
      'Like the dashboard of a car: you get a wheel, pedals, and gauges, and you do not need to know how the engine is arranged inside. A clear interface lets one part change internally without forcing everything around it to change too.',
    plainExplain_zh:
      '就像汽车的仪表台：你得到方向盘、踏板和仪表，而不必知道发动机内部如何布置。清晰的接口让某一部分可以在内部改变，而不强迫周围所有东西跟着改。',
    proExplain_en:
      'A named contract of function signatures, types, or endpoints that callers depend on. VibeBaton groups tasks that touch the same interface under one dependency edge, so parallel workers do not invent incompatible versions of the same boundary.',
    proExplain_zh:
      '由函数签名、类型或端点组成的具名契约，调用方依赖它工作。VibeBaton 会把触及同一接口的任务放进同一条依赖边，避免并行执行者各自造出互不兼容的边界实现。',
    related: ['contract', 'module', 'schema', 'api'],
  },
  {
    id: 'contract',
    term: 'Contract',
    category: 'engineering',
    oneLiner_en: 'The promises two components make about how they will exchange data and errors.',
    oneLiner_zh: '两个组件之间关于如何交换数据与错误的承诺。',
    plainExplain_en:
      'Like a delivery agreement that fixes the address, the package size, and what happens if nobody is home. Both sides can work independently only because they agree on the same details. When a contract changes, every caller must be updated together.',
    plainExplain_zh:
      '就像一份配送协议，写明地址、包裹尺寸以及没人在家时怎么办。只有双方对同样的细节达成一致，才能各自独立工作。契约一旦改变，所有调用方都必须一起更新。',
    proExplain_en:
      'The observable agreement between modules: request and response shapes, status codes, error types, and side effects. VibeBaton integration tests and the review step target contract mismatches, because code can compile while two modules still disagree about what they send each other.',
    proExplain_zh:
      '模块之间可观测的约定：请求与响应的结构、状态码、错误类型以及副作用。VibeBaton 的集成测试和评审环节专门检查契约不一致，因为代码可以编译通过，而两个模块对彼此发送什么仍然存在分歧。',
    related: ['interface', 'schema', 'integration-test', 'api'],
  },
  {
    id: 'schema',
    term: 'Schema',
    category: 'engineering',
    oneLiner_en: 'A formal description of the shape and allowed values of structured data.',
    oneLiner_zh: '对结构化数据的形状与允许取值的正式描述。',
    plainExplain_en:
      'Like a customs form with labeled boxes and rules about what may go in each one: date here, signature there, no entries in the wrong field. A schema lets a computer check a document before anything tries to use it.',
    plainExplain_zh:
      '就像一张海关申报表，每个格子都有标签和填写规则：日期填这里、签名填那里，不能填错栏。模式让计算机可以先检查文档，再交给其他程序使用。',
    proExplain_en:
      'A typed definition such as a JSON Schema, a database table definition, or a Zod model that validates structure at a boundary. VibeBaton validates run state and plan files against their schemas before acting, so a malformed file produces a clear error instead of a confusing crash later.',
    proExplain_zh:
      'JSON Schema、数据库表定义或 Zod 模型这类带类型的定义，在边界处校验数据结构。VibeBaton 在行动之前会先按模式校验运行状态和计划文件，因此格式错误的文件会得到清晰报错，而不是之后莫名其妙的崩溃。',
    related: ['contract', 'interface', 'json', 'structured-output'],
  },
  {
    id: 'acceptance-criteria',
    term: 'Acceptance Criteria',
    category: 'engineering',
    oneLiner_en: 'The concrete conditions a deliverable must satisfy to be considered done.',
    oneLiner_zh: '交付物必须满足才算完成的具体条件。',
    plainExplain_en:
      'Like a checklist a building inspector carries: not "the plumbing seems fine," but "hot water reaches the second floor within thirty seconds." Good criteria are observable, specific, and testable, so "done" is not a matter of opinion.',
    plainExplain_zh:
      '就像验收员手里的检查清单：不是“水管看起来还行”，而是“热水在三十秒内到达二楼”。好的验收标准是可观察、具体且可测试的，这样“完成”就不是主观判断。',
    proExplain_en:
      'A required section of the VibeBaton RFC and plan, listing the observable outcomes that prove a task succeeded, usually paired with a verification command. The mechanical gate checks those outcomes before review, and a task without testable criteria is flagged during planning rather than after implementation.',
    proExplain_zh:
      'VibeBaton 的 RFC 与计划中的必需章节，列出能证明任务成功的可观察结果，通常还会配上验证命令。机械门禁会在评审前检查这些结果；如果任务没有可测试的标准，会在规划阶段而不是实现完成后被标记出来。',
    related: ['rfc', 'spec', 'mechanical-gate', 'final-gate'],
  },
  {
    id: 'spec',
    term: 'Spec',
    matchCase: true,
    category: 'engineering',
    oneLiner_en: 'A written description of what a system should do and the rules it must follow.',
    oneLiner_zh: '说明系统应当做什么、必须遵守哪些规则的书面描述。',
    plainExplain_en:
      'Like the blueprint for a house: it fixes the rooms, dimensions, and materials before anyone swings a hammer. A spec is not a wish list; it is the reference everyone can point to when a disagreement arises.',
    plainExplain_zh:
      '就像房屋的蓝图：在动锤子之前就确定房间、尺寸和材料。规格不是愿望清单，而是出现分歧时所有人都能指向的参照。',
    proExplain_en:
      'A document defining intended behavior, scope, and constraints, from which tasks and acceptance criteria are derived. VibeBaton keeps the RFC as the run-level spec and treats specs already in the repository as binding context, so workers do not invent behavior the project never promised.',
    proExplain_zh:
      '定义预期行为、范围与约束的文档，任务和验收标准都从它派生。VibeBaton 把 RFC 作为运行级规格，并把仓库中已有的 spec 视为有约束力的上下文，避免执行者发明项目从未承诺过的行为。',
    related: ['rfc', 'acceptance-criteria', 'contract', 'schema'],
  },
  {
    id: 'code-review',
    term: 'Code Review',
    category: 'engineering',
    oneLiner_en: 'A careful reading of a change by someone other than its author before it lands.',
    oneLiner_zh: '改动合入之前，由作者之外的其他人仔细阅读检查。',
    plainExplain_en:
      'Like having a second pair of eyes check a navigation before the trip: the driver may be tired or too close to the route to notice a wrong turn. Review catches intent gaps, risky assumptions, and missing tests that tooling cannot judge.',
    plainExplain_zh:
      '就像出发前让另一个人再核对一遍导航：司机可能疲劳，或因为太熟悉路线而没注意到拐错。评审能发现工具无法判断的意图偏差、高风险假设和缺失的测试。',
    proExplain_en:
      'A review of the diff against acceptance criteria and repository conventions, performed by an independent reviewer role. VibeBaton runs `ai-review` after the mechanical gate passes, so style and test results alone do not substitute for judging whether the change is the right one.',
    proExplain_zh:
      '由独立的评审者角色对照验收标准和仓库约定来检查 diff。VibeBaton 在机械门禁通过后执行 `ai-review`，因此风格检查和测试结果都不能替代“这处改动是否方向正确”的判断。',
    related: ['diff', 'ai-review', 'acceptance-criteria', 'tech-debt'],
  },
  {
    id: 'deployment',
    term: 'Deployment',
    category: 'engineering',
    oneLiner_en: 'The step that puts a built version of the software where users can run it.',
    oneLiner_zh: '把构建好的软件放到用户可运行位置的过程。',
    plainExplain_en:
      'Like moving a finished dish from the kitchen to the dining room: cooking it correctly is not enough if it is delivered to the wrong table or left under a heat lamp. Deployment has its own risks, and a rollback plan matters as much as the release itself.',
    plainExplain_zh:
      '就像把做好的菜从厨房送到餐厅：做得再好，送错桌或一直放在保温灯下也会出问题。部署本身有独立的风险，回滚方案和发布方案同样重要。',
    proExplain_en:
      'Shipping an artifact to an environment such as staging or production, including configuration, migrations, and health checks. VibeBaton keeps deployment outside the autonomous task loop unless explicitly gated, and requires a recorded rollback path so a failed release can be reversed.',
    proExplain_zh:
      '把产物发布到预发或生产等环境，包括配置、迁移和健康检查。除非有明确门禁，VibeBaton 会把部署留在自主任务循环之外，并要求记录回滚路径，以便发布失败时能够撤销。',
    related: ['build', 'environment-variable', 'rollback', 'final-gate'],
  },
  {
    id: 'environment-variable',
    term: 'Environment Variable',
    category: 'engineering',
    oneLiner_en: 'A named value supplied by the operating system or shell at runtime.',
    oneLiner_zh: '由操作系统或 shell 在运行时提供的具名取值。',
    plainExplain_en:
      'Like the settings on a thermostat that the room does not control: the same room behaves differently depending on what the building sets. Environment variables let one program run in dev, test, or production without editing its code.',
    plainExplain_zh:
      '就像由整栋楼统一设定、房间自己不能改的恒温器：同一个房间会因楼里的设置不同而表现不同。环境变量让同一份程序无需改代码就能在开发、测试或生产环境运行。',
    proExplain_en:
      'A `KEY=value` pair read from the process environment, commonly used for secrets, paths, and mode switches. VibeBaton documents required variables while keeping credentials out of the repository, and the verification command inherits the same environment in which the server or tests actually run.',
    proExplain_zh:
      '从进程环境读取的 `KEY=value` 键值对，常用于密钥、路径和模式开关。VibeBaton 会记录必需的环境变量，同时确保凭据不进入仓库；验证命令也会继承服务器或测试实际运行时的同一套环境。',
    related: ['config-file', 'api-key', 'deployment', 'cli'],
  },
  {
    id: 'config-file',
    term: 'Config File',
    category: 'engineering',
    oneLiner_en: 'A file that holds settings a program reads when it starts.',
    oneLiner_zh: '保存程序启动时读取的设置的文件。',
    plainExplain_en:
      'Like the address book and preferences saved in your phone: you set them once, and every app follows them until you change them. Config files make behavior adjustable without editing source code or retyping options every time.',
    plainExplain_zh:
      '就像手机里保存的通讯录和偏好设置：设置一次，所有应用都照此运行，直到你主动修改。配置文件让行为无需改源码、也无需每次重新输入参数就能调整。',
    proExplain_en:
      'A declarative file such as `tsconfig.json`, `vite.config.ts`, `pyproject.toml`, or `.baton/config.json` that is read at startup. VibeBaton treats repository config as part of the contract: a task may edit one only when its `allowed_paths` include it, and verification reruns with the edited config.',
    proExplain_zh:
      '在启动时读取的声明式文件，例如 `tsconfig.json`、`vite.config.ts`、`pyproject.toml` 或 `.baton/config.json`。VibeBaton 把仓库配置视为契约的一部分：只有在 `allowed_paths` 包含该文件时任务才能修改它，并且验证会用修改后的配置重新运行。',
    related: ['environment-variable', 'schema', 'allowed-paths', 'build'],
  },
  {
    id: 'logging',
    term: 'Logging',
    category: 'engineering',
    oneLiner_en: 'Recording what a program did so problems can be understood after the fact.',
    oneLiner_zh: '记录程序做过什么，以便事后分析问题。',
    plainExplain_en:
      'Like the logbook on a ship: the journey may be routine, but when something goes wrong the log is the only honest witness. Good logs include timestamps, context, and the actual error, and never the secrets you would regret printing.',
    plainExplain_zh:
      '就像航海日志：行程平时或许平淡，但一旦出问题，日志是唯一诚实的见证者。好的日志包含时间戳、上下文和真实错误，绝不会打印那些事后会让你后悔的密钥。',
    proExplain_en:
      'Structured output at levels such as debug, info, warn, and error, written to stderr or a log file with enough context to reproduce the issue. VibeBaton captures the output of each task for the battle report, and failure diagnosis starts from the logged command, exit code, and error text rather than from guesswork.',
    proExplain_zh:
      '按 debug、info、warn、error 等等级输出的结构化信息，写入 stderr 或日志文件，并带有足够复现问题的上下文。VibeBaton 会为战报捕获每个任务的输出，故障诊断从记录下来的命令、退出码和错误文本开始，而不是靠猜。',
    related: ['stack-trace', 'exit-code', 'battle-report', 'daemon'],
  },
  {
    id: 'race-condition',
    term: 'Race Condition',
    category: 'engineering',
    oneLiner_en: 'A bug where the outcome depends on unpredictable timing between concurrent operations.',
    oneLiner_zh: '结果取决于并发操作之间不可预测时序的缺陷。',
    plainExplain_en:
      'Two people reaching for the same door handle at the same moment: each is polite, but the result depends on who gets there first. Race conditions are hard to reproduce because they disappear when you slow the program down to watch.',
    plainExplain_zh:
      '两个人同时伸手去握同一个门把手：各自都很正常，结果却取决于谁先到。竞态条件难复现，因为当你放慢程序想观察它时，它往往就消失了。',
    proExplain_en:
      'A defect whose result varies with the interleaving of threads, processes, or async tasks, for example two workers writing the same state file. VibeBaton limits concurrency and serializes tasks that touch shared files, and atomic writes prevent the most common lost-update races.',
    proExplain_zh:
      '结果随线程、进程或异步任务的交错顺序而变化的缺陷，例如两个执行者同时写同一个状态文件。VibeBaton 会限制并发并串行化触及共享文件的任务，原子写入则能避免最常见的丢失更新竞态。',
    related: ['concurrency', 'atomic-write', 'deadlock', 'idempotent'],
  },
  {
    id: 'concurrency',
    term: 'Concurrency',
    category: 'engineering',
    oneLiner_en: 'Doing several tasks at the same time rather than strictly one after another.',
    oneLiner_zh: '同时推进多项任务，而不是严格地一件接一件做。',
    plainExplain_en:
      'Like a kitchen with several cooks: more dishes finish sooner, but only if they do not fight over the same cutting board. Concurrency is a throughput lever, and every shared surface needs a rule about who uses it when.',
    plainExplain_zh:
      '就像有几位厨师的厨房：菜能更快做完，但前提是大家不会争抢同一块砧板。并发是提升吞吐的手段，而每一处共享资源都需要约定谁在什么时候使用。',
    proExplain_en:
      'Running multiple tasks with overlapping time windows, whether through threads, processes, or async I/O. The VibeBaton engine runs independent plan tasks in parallel up to a configured cap while serializing tasks with a dependency edge, so concurrency raises throughput without breaking shared state.',
    proExplain_zh:
      '通过线程、进程或异步 I/O 让多个任务在时间上重叠执行。VibeBaton 引擎会在配置的上限内并行运行互不依赖的计划任务，同时把有依赖边的任务串行化，从而在提高吞吐量的同时不破坏共享状态。',
    related: ['race-condition', 'deadlock', 'dag', 'daemon'],
  },
  {
    id: 'cli',
    term: 'CLI',
    category: 'engineering',
    oneLiner_en: 'A text interface where you type commands instead of clicking buttons.',
    oneLiner_zh: '通过输入命令而非点击按钮来操作程序的文本界面。',
    plainExplain_en:
      'Like ordering at a counter instead of browsing a menu: you say exactly what you want and can see the result immediately. CLIs are fast to script, which is why automated workers and CI pipelines prefer them.',
    plainExplain_zh:
      '就像在柜台直接点单而不是翻菜单：你说清楚要什么，立刻就能看到结果。CLI 很容易写成脚本，因此自动化执行者和 CI 流水线都偏爱它。',
    proExplain_en:
      'Command-Line Interface, a program driven by arguments, flags, stdin, and exit codes, such as `git`, `npm`, or `tsc`. The VibeBaton CLI drivers invoke coding agents this way and rely on exit codes plus captured output to decide whether a task passed.',
    proExplain_zh:
      'Command-Line Interface（命令行界面），通过参数、选项、标准输入和退出码驱动的程序，例如 `git`、`npm` 或 `tsc`。VibeBaton 的 CLI 驱动就是这样调用编码智能体的，并依靠退出码和捕获的输出判断任务是否通过。',
    related: ['cli-driver', 'exit-code', 'sandbox', 'command-not-found'],
  },
  {
    id: 'sandbox',
    term: 'Sandbox',
    category: 'engineering',
    oneLiner_en: 'A restricted environment where code can run without affecting the wider system.',
    oneLiner_zh: '让代码在不影响整个系统的前提下运行的受限环境。',
    plainExplain_en:
      'Like a sandbox in a yard: play is allowed, but the sand stays inside the walls. Software sandboxes limit which files, network, and commands a process may touch, so an experiment cannot damage the host.',
    plainExplain_zh:
      '就像院子里的沙坑：可以随便玩，但沙子只留在围墙之内。软件沙箱限制进程能访问哪些文件、网络和命令，因此实验不会破坏宿主机。',
    proExplain_en:
      'An isolation boundary such as a container, a restricted user, or an OS-level file sandbox that constrains file writes, network access, and spawned processes. VibeBaton runs workers inside a task worktree with an `allowed_paths` whitelist, which is a workspace sandbox rather than a security boundary against a hostile agent.',
    proExplain_zh:
      '容器、受限用户或操作系统级文件沙箱这类隔离边界，用来限制文件写入、网络访问和子进程。VibeBaton 让执行者在带 `allowed_paths` 白名单的任务 worktree 中工作，这属于工作区沙箱，而不是用于抵御恶意智能体的安全边界。',
    related: ['allowed-paths', 'worktree', 'permission-denied', 'cli'],
  },
  {
    id: 'backup',
    term: 'Backup',
    category: 'engineering',
    oneLiner_en: 'A saved copy of data that can be restored if the original is lost or damaged.',
    oneLiner_zh: '在原始数据丢失或损坏时可以恢复的副本。',
    plainExplain_en:
      'Like keeping a spare house key: you hope never to use it, but the day the door locks behind you, its value is obvious. A backup only counts once you have tested that it can actually be restored.',
    plainExplain_zh:
      '就像留一把备用钥匙：希望永远用不上，但被锁在门外的那天，它的价值不言而喻。备份只有在实际验证过能够恢复之后才算数。',
    proExplain_en:
      'A point-in-time copy stored somewhere separate from the working data, with a defined restore procedure. VibeBaton tags the base branch head as `baton-backup/<run_id>` before a run, so a failed or misdirected change can be recovered without relying on the worker to undo itself.',
    proExplain_zh:
      '存放在工作数据之外的时间点副本，并配有明确的恢复流程。VibeBaton 会在运行前把基础分支的最新提交标记为 `baton-backup/<run_id>`，因此失败或走偏的改动无需依赖执行者自我撤销就能恢复。',
    related: ['baton-backup', 'rollback', 'repository', 'atomic-write'],
  },
];
