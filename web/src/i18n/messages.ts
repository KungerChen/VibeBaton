import type { TourStepId } from '../components/tour/tourSteps';
import type { AttentionCategory, BudgetProfile, CostTier, ExecutionState, NodeType, PresetCategory, Scenario, TraceKind } from '../types/graph';

export type Locale = 'en' | 'zh';

// M3 Guided contract: all new Guided leaf copy lives under guided.m3.
// The recommendation reason names match the server's workflow.<reason_code> keys.
const GUIDED_M3_EN = {
  stepper: {
    aria: 'Guided progress',
    setup: 'Workspace',
    blueprint: 'Blueprint',
    build: 'Build',
    signoff: 'Sign-off',
    current: 'Current step',
    completed: 'Completed step',
  },
  cliSummary: {
    title: 'Coding tools',
    ready: 'Ready',
    needsSignIn: 'Sign-in needed',
    missing: 'Not installed',
    prerequisite: 'Prerequisite needed',
    scan: 'Scan tools',
    scanning: 'Scanning tools…',
    rescan: 'Scan again',
    details: 'Show tool details',
    empty: 'No coding tools found yet.',
  },
  installConfirm: {
    title: 'Install coding tool?',
    description: 'This runs the installation command shown below on this computer.',
    command: 'Installation command',
    confirm: 'Install',
    cancel: 'Cancel',
    installing: 'Installing…',
    success: 'Installation finished. Scan again to check readiness.',
    failed: 'Installation failed.',
  },
  signin: {
    title: 'Sign in to continue',
    description: 'Complete sign-in in the opened window, then scan again.',
    action: 'Open sign-in',
    opening: 'Opening sign-in…',
    highlight: 'Sign-in is required for this tool.',
    failed: 'Could not open sign-in.',
  },
  l0Model: {
    label: 'Architecture partner',
    auto: 'Automatic selection',
    selected: 'Selected model',
    unavailable: 'No ready models found.',
    loading: 'Loading models…',
    failed: 'Could not load models.',
    retry: 'Retry loading models',
    change: 'Change model',
  },
  brainstorm: {
    respondingModel: 'Responded with',
    requestedModel: 'Requested model',
    modelUnknown: 'Model not reported',
    offlineGuard: 'The online draft was preserved. The latest reply could not be generated online.',
    retry: 'Retry online',
    retrying: 'Retrying…',
    preservedDraft: 'Your current draft is preserved.',
    stale: 'The session changed during this turn. Reload it before retrying.',
    reload: 'Reload session',
  },
  launch: {
    title: 'Ready to build',
    action: 'Start build',
    launching: 'Starting build…',
    retry: 'Retry start',
    confirm: 'Confirm and start',
    blocked: 'Complete the blueprint and select a ready team before starting.',
    uncertain: 'The start result is unknown. Retry with the same request to check.',
    preflightFailed: 'The selected team is no longer ready. Review the available options.',
    activeRun: 'A build is already active.',
    flowLean: 'Lean flow: one model builds it and another reviews it, with no separate planning step. The checks and your final sign-off still run.',
    flowFull: 'Full flow: the work is planned first, then built and reviewed.',
    flowFullSmall: 'Full flow: the work is planned first. Small projects are split into fewer tasks and skip the per-task review; the tests and the final check still run.',
    flowWhy: {
      size_not_small: 'The lean flow is only for small projects.',
      panel_mode: 'The lean flow is not used while the specialist panel is on.',
      no_verification_command: 'The lean flow needs a check command in the document that can run as written.',
      lean_flow_off: 'You turned the lean flow off for this run.',
    },
    flowChecking: 'Checking which flow this run will use...',
    flowInherited: 'A revision keeps the flow setting of the previous run.',
    leanSwitch: 'Use the lean flow',
    thisRunOnly: 'This run only',
    projectDefault: 'Project default',
    confirmTitle: 'Check what this run will use',
    confirmDocument: 'Document',
    untitled: 'Untitled document',
    confirmTeam: 'Team',
    confirmMode: 'How it runs',
    modePanel: 'Specialist panel first, then automatic build',
    confirmFlow: 'Flow',
    confirmBudget: 'Budget',
    budgetLoading: 'Loading...',
    budgetUnavailable: 'Could not read the project budget.',
    changeBudget: 'Change it in Pro mode',
    missingSections: 'The document is missing these sections: {sections}. You can still start the build.',
    back: 'Back',
  },
  lineup: {
    title: 'Team lineup',
    description: 'Pick a tool, model and thinking effort for each role. Changes here apply to this run only; save the team below to reuse it.',
    open: 'Change team',
    close: 'Close team lineup',
    role: 'Role',
    provider: 'Tool',
    model: 'Model',
    effort: 'Thinking effort',
    defaultModel: 'Tool default',
    preset: 'Workflow preset',
    useRecommendation: 'Use recommended team',
    save: 'Apply team',
    cancel: 'Cancel',
    unavailable: 'This selection is not ready.',
    missing: 'No complete team is available.',
    changed: 'Team updated.',
  },
  recommendation: {
    title: 'Recommended plan',
    fallback: 'A fallback was selected',
    size: 'Project size',
    small: 'Small',
    medium: 'Medium',
    large: 'Large',
    sizeWords: { small: 'small', medium: 'medium-sized', large: 'large' },
    unknownSize: 'Size not specified',
    unknownReason: 'Review the recommended workflow and team.',
    mode: 'Workflow',
    interactive: 'Interactive',
    overnight: 'Automatic build',
    panel: 'Specialist panel',
    panelHelp: 'Before building, several AI specialists review the plan from different angles. Safer, but slower and uses more credits.',
    panelUnavailable: 'Not available right now: ',
    panelPartial: 'Some specialists are not ready ({names}); the panel would run with the others.',
    substitutions: 'Provider substitutions',
    previousTeam: 'Previous team retained',
    sizeChanged: 'Project size changed',
    headlines: {
      small_eco: 'This is a {size} project, so a lean team will build it automatically.',
      medium_relay: 'This is a {size} project, so the team below will build it automatically.',
      large_panel: 'This is a {size} project, so specialists review the plan first and the team below builds it automatically.',
      large_relay: 'This is a {size} project. The team below will build it automatically; the specialist panel is not fully ready.',
      custom_lineup_kept: 'This is a {size} project, and your own team below will build it automatically.',
      no_lineup: 'No ready team yet. Connect a coding tool in Workspace first.',
    },
    reasons: {
      size_from_model: 'The AI partner judged this a {size} project.',
      size_estimated: 'Judged a {size} project from what the blueprint lists.',
      size_defaulted_to_medium: 'No size was given, so it is treated as medium-sized.',
      small_eco: 'Planning and review keep strong models; the building work uses faster, cheaper ones.',
      medium_relay: 'It uses the team from Workspace, with each role on its recommended model.',
      large_panel: 'Every specialist is ready, so the panel can review the plan first.',
      large_relay: 'The same team builds it without the specialist panel.',
      effort_adjusted: 'A saved thinking-effort setting was not offered by its tool, so it was changed to one that is.',
      custom_lineup_kept: 'You changed the team yourself, so it is kept as it is.',
      eco_model_unavailable: 'No lighter model is ready, so the regular team is used.',
      provider_substituted: 'A tool that is not ready was replaced with a ready one.',
      no_ready_provider: 'No tool is ready. Set up a coding tool or an API key in Workspace.',
      lineup_unavailable: 'A complete ready team could not be put together.',
      synthesizer_not_configured: 'The panel has no summarizing model set up.',
      synthesizer_provider_unavailable: 'The tool that summarizes the panel is not ready.',
      synthesizer_credentials_missing: 'The tool that summarizes the panel needs an API key.',
      panelist_unavailable: 'No panel specialist is ready.',
      panelist_not_ready: 'Some panel specialists are not ready: {names}.',
    },
  },
  workflowSwitch: {
    label: 'Workflow',
    switchToPanel: 'Use specialist panel',
    switchToOvernight: 'Build without the panel',
    switchAction: 'Switch workflow',
    dismiss: 'Dismiss',
    panel: 'Specialist panel',
    overnight: 'Automatic build',
    interactive: 'Interactive',
    disabled: 'This workflow is not ready.',
    changed: 'Workflow updated.',
  },
  humanGate: {
    title: 'Decision needed',
    description: 'Review the current decision before continuing.',
    task: 'Task',
    run: 'Run',
    note: 'Your note',
    approve: 'Approve',
    reject: 'Request changes',
    submit: 'Submit decision',
    submitting: 'Submitting…',
    close: 'Close',
    stale: 'This decision is no longer available. Refresh the run.',
    failed: 'Could not submit the decision.',
  },
  failed: {
    title: 'Build failed',
    description: 'Review the failure details and decide how to continue.',
    details: 'Failure details',
    noDetails: 'No failure details were reported.',
    retry: 'Retry failed work',
    replan: 'Stop & Replan',
    stopping: 'Stopping…',
    replanHint: 'Stop the run, then revise the blueprint using the failure context.',
  },
  signOff: {
    title: 'Review and sign off',
    baseBranch: 'Base branch',
    baseSha: 'Base at launch',
    startSha: 'Run start',
    resultSha: 'Run result',
    currentBaseSha: 'Current base',
    mergedSha: 'Merged commit',
    parentRun: 'Previous run',
    currentRun: 'Current run',
    approve: 'Approve & Merge',
    merging: 'Merging…',
    merged: 'Changes merged.',
    reintegrated: 'Changes integrated with the updated base and checks passed.',
    gateFailed: 'A check failed after integration. The base was not updated.',
    conflict: 'Changes conflict with the current base.',
    changedFiles: 'Changed files',
    gates: 'Checks',
    noGates: 'No additional checks were configured.',
  },
  revision: {
    title: 'Request changes',
    note: 'Describe the changes',
    placeholder: 'What should change?',
    submit: 'Start revision',
    submitting: 'Starting revision…',
    required: 'Describe the requested changes.',
    created: 'Revision started.',
    context: 'Previous failure context',
    parent: 'Previous run',
    child: 'Revision run',
    inheritedWorkflow: 'The revision uses the previous run’s workflow and team; the server checks their readiness again.',
  },
  rollback: {
    title: 'Roll back changes',
    mode: 'Choose what to restore',
    revertRevision: 'Undo latest revision',
    revertRevisionHint: 'Move the unmerged run branch to the previous revision result.',
    abandonAll: 'Abandon all revisions',
    abandonAllHint: 'Move the unmerged run branch to the original starting commit.',
    undo: 'Undo merged changes',
    undoHint: 'Restore the base to its pre-merge commit while the merge remains at its head.',
    serverChecksHead: 'The server checks the current branch head before undoing the merge.',
    confirm: 'Confirm rollback',
    cancel: 'Cancel',
    working: 'Rolling back…',
    restored: 'Restored to commit',
    paused: 'The run is paused after rollback. Resume it or replan the blueprint.',
    moved: 'The base has advanced. Review the suggested revert guidance.',
  },
  drift: {
    title: 'The base branch changed',
    description: 'The result will be integrated with the current base and its checks rerun before merge.',
    conflict: 'Resolve the listed conflicts before trying again.',
    gateFailed: 'Review the failed checks before trying again.',
    baseMoved: 'The base changed during approval. Retry to check the latest commit.',
    branchMoved: 'The run changed during approval. Refresh it before trying again.',
    dirty: 'Commit or stash workspace changes before approval.',
  },
  session: {
    loading: 'Loading session…',
    loadFailed: 'Could not load the session.',
    saveFailed: 'Could not save the session. Retry before continuing.',
    retrySave: 'Retry saving',
    reset: 'Start a new session',
    resetConfirm: 'Discard the saved draft and start a new session? This does not stop an existing run.',
    cancel: 'Cancel',
    confirmReset: 'Discard and reset',
  },
  errors: {
    RUN_SUPERSEDED: 'This run has been replaced by a newer run.',
    RUN_STALE: 'The run changed. Refresh its status and try again.',
    RUN_BUSY: 'The run is busy. Wait for the current operation to finish.',
    STOP_PENDING: 'The stop is still settling. Retry after the work stops.',
    INTEGRATION_CONFLICT: 'The result conflicts with the current base.',
    GATE_FAILED: 'An integration check failed.',
    GATE_EXECUTION_FAILED: 'An integration check could not run.',
    INVALID_GATES: 'The configured checks could not be read.',
    BASE_MOVED: 'The base changed during approval. Retry approval.',
    BASE_CHECKED_OUT: 'The base branch is checked out in another worktree.',
    DIRTY_WORKTREE: 'Commit or stash workspace changes first.',
    MERGE_NOT_HEAD: 'The base has advanced beyond this merge. Review the revert guidance.',
    LAUNCH_KEY_CONFLICT: 'This launch request belongs to another run.',
    LAUNCH_FAILED: 'The build could not be started.',
    REVISION_FAILED: 'The revision could not be started.',
    INTEGRATION_FAILED: 'The result could not be integrated.',
    GIT_ERROR: 'The Git operation failed.',
    LAUNCH_PREFLIGHT: 'The selected workflow is no longer ready.',
    READINESS_UNAVAILABLE: 'Provider readiness could not be checked.',
    SESSION_IO_ERROR: 'The session could not be read or saved.',
    BRAINSTORM_SESSION_CHANGED: 'The session changed during this turn. Reload it before retrying.',
    unknown: 'The operation failed. Review the details and try again.',
  },
};

type StringShape<T> = { [K in keyof T]: T[K] extends string ? string : StringShape<T[K]> };
export type GuidedM3Messages = StringShape<typeof GUIDED_M3_EN>;
const GUIDED_M3_ZH: GuidedM3Messages = {
  stepper: {
    aria: '引导进度',
    setup: '工作区',
    blueprint: '蓝图',
    build: '施工',
    signoff: '验收',
    current: '当前步骤',
    completed: '已完成步骤',
  },
  cliSummary: {
    title: '编程工具',
    ready: '已就绪',
    needsSignIn: '需要登录',
    missing: '未安装',
    prerequisite: '缺少前置依赖',
    scan: '扫描工具',
    scanning: '正在扫描工具……',
    rescan: '重新扫描',
    details: '查看工具详情',
    empty: '尚未找到编程工具。',
  },
  installConfirm: {
    title: '安装编程工具？',
    description: '将在本机运行下方显示的安装命令。',
    command: '安装命令',
    confirm: '安装',
    cancel: '取消',
    installing: '正在安装……',
    success: '安装已完成，请重新扫描以检查状态。',
    failed: '安装失败。',
  },
  signin: {
    title: '登录后继续',
    description: '在打开的窗口中完成登录，然后重新扫描。',
    action: '打开登录',
    opening: '正在打开登录……',
    highlight: '此工具需要登录。',
    failed: '无法打开登录窗口。',
  },
  l0Model: {
    label: '架构伙伴',
    auto: '自动选择',
    selected: '已选模型',
    unavailable: '没有找到就绪模型。',
    loading: '正在加载模型……',
    failed: '无法加载模型。',
    retry: '重新加载模型',
    change: '切换模型',
  },
  brainstorm: {
    respondingModel: '实际回复模型',
    requestedModel: '请求的模型',
    modelUnknown: '未报告模型',
    offlineGuard: '在线草稿已保留，本次未能生成在线回复。',
    retry: '重试在线生成',
    retrying: '正在重试……',
    preservedDraft: '当前草稿已保留。',
    stale: '本轮进行期间会话发生变化，请重新加载后再试。',
    reload: '重新加载会话',
  },
  launch: {
    title: '准备开始施工',
    action: '开始施工',
    launching: '正在启动施工……',
    retry: '重试启动',
    confirm: '确认并启动',
    blocked: '请先完成蓝图并选择已就绪的团队。',
    uncertain: '启动结果尚不确定，请使用同一请求重试以确认。',
    preflightFailed: '所选团队已不再就绪，请检查可用选项。',
    activeRun: '已有施工正在进行。',
    flowLean: '精简流程：一个模型施工、另一个模型审查，不单独做规划；检查和最后的验收照常进行。',
    flowFull: '完整流程：先做规划，再施工和审查。',
    flowFullSmall: '完整流程：先做规划。小项目会少拆任务、省去逐任务审校，测试和最终把关照常进行。',
    flowWhy: {
      size_not_small: '精简流程只用于小项目。',
      panel_mode: '开着专家小组时不用精简流程。',
      no_verification_command: '精简流程需要文档里有能直接运行的检查命令。',
      lean_flow_off: '你为本次运行关掉了精简流程。',
    },
    flowChecking: '正在确认本次运行用哪种流程……',
    flowInherited: '修订沿用上一次运行的流程设置。',
    leanSwitch: '用精简流程',
    thisRunOnly: '仅本次运行',
    projectDefault: '项目默认',
    confirmTitle: '核对本次运行将使用的设置',
    confirmDocument: '文档',
    untitled: '未命名文档',
    confirmTeam: '团队',
    confirmMode: '执行方式',
    modePanel: '先专家小组，再自动施工',
    confirmFlow: '流程',
    confirmBudget: '预算',
    budgetLoading: '正在读取……',
    budgetUnavailable: '读不到项目预算。',
    changeBudget: '去专业模式修改',
    missingSections: '文档还缺这些章节：{sections}。仍可以开始施工。',
    back: '返回',
  },
  lineup: {
    title: '团队阵容',
    description: '为每个角色选择工具、型号和思考强度。这里的改动只用于本次运行；想以后再用，可以在下面保存团队。',
    open: '调整团队',
    close: '关闭团队阵容',
    role: '角色',
    provider: '工具',
    model: '型号',
    effort: '思考强度',
    defaultModel: '工具默认',
    preset: '工作流预设',
    useRecommendation: '使用推荐团队',
    save: '应用团队',
    cancel: '取消',
    unavailable: '此选项尚未就绪。',
    missing: '没有可用的完整团队。',
    changed: '团队已更新。',
  },
  recommendation: {
    title: '推荐方案',
    fallback: '已选择备用方案',
    size: '项目规模',
    small: '小型',
    medium: '中型',
    large: '大型',
    sizeWords: { small: '小', medium: '中等规模的', large: '大' },
    unknownSize: '未指定规模',
    unknownReason: '请检查推荐的工作流和团队。',
    mode: '工作流',
    interactive: '交互模式',
    overnight: '自动施工',
    panel: '专家小组',
    panelHelp: '开工前先请几位 AI 专家从不同角度审一遍计划，更稳妥，但更慢、更费额度。',
    panelUnavailable: '暂不可用：',
    panelPartial: '有专家还没就绪（{names}），开启后会由其余专家审阅。',
    substitutions: '供应方替换',
    previousTeam: '已保留原团队',
    sizeChanged: '项目规模已变化',
    headlines: {
      small_eco: '这是个{size}项目，建议用精简团队自动施工。',
      medium_relay: '这是个{size}项目，建议由下面的团队自动施工。',
      large_panel: '这是个{size}项目，建议先请专家小组审阅计划，再由下面的团队自动施工。',
      large_relay: '这是个{size}项目，建议由下面的团队自动施工；专家小组还没完全就绪。',
      custom_lineup_kept: '这是个{size}项目，会按你自己定的团队自动施工。',
      no_lineup: '还没有就绪的团队，请先在「工作区」连接一个编程工具。',
    },
    reasons: {
      size_from_model: 'AI 伙伴判断这是个{size}项目。',
      size_estimated: '根据蓝图里列出的内容，估计这是个{size}项目。',
      size_defaulted_to_medium: '没有给出规模，按中等规模处理。',
      small_eco: '规划和把关用强模型，动手干活用更快、更省的模型。',
      medium_relay: '沿用「工作区」的团队，每个角色用它的推荐型号。',
      large_panel: '所有专家都已就绪，可以先审阅计划。',
      large_relay: '由同一支团队施工，不经过专家小组。',
      effort_adjusted: '保存的团队里有工具不支持的思考强度，已换成它支持的档位。',
      custom_lineup_kept: '你亲手调整过团队，所以原样保留。',
      eco_model_unavailable: '没有就绪的轻量模型，改用常规团队。',
      provider_substituted: '有工具没就绪，已换成就绪的工具。',
      no_ready_provider: '还没有就绪的工具，请在「工作区」设置编程工具或接口密钥。',
      lineup_unavailable: '凑不出一支完整的就绪团队。',
      synthesizer_not_configured: '专家小组没有设置汇总模型。',
      synthesizer_provider_unavailable: '专家小组的汇总工具还没就绪。',
      synthesizer_credentials_missing: '专家小组的汇总工具缺少接口密钥。',
      panelist_unavailable: '专家小组里没有就绪的专家。',
      panelist_not_ready: '有专家还没就绪：{names}。',
    },
  },
  workflowSwitch: {
    label: '工作流',
    switchToPanel: '使用专家小组',
    switchToOvernight: '不用专家小组，直接自动施工',
    switchAction: '一键切换',
    dismiss: '忽略',
    panel: '专家小组',
    overnight: '自动施工',
    interactive: '交互模式',
    disabled: '此工作流尚未就绪。',
    changed: '工作流已更新。',
  },
  humanGate: {
    title: '需要决策',
    description: '继续之前，请检查当前决策。',
    task: '任务',
    run: '运行',
    note: '你的说明',
    approve: '通过',
    reject: '提出修改',
    submit: '提交决策',
    submitting: '正在提交……',
    close: '关闭',
    stale: '此决策已不可用，请刷新运行状态。',
    failed: '无法提交决策。',
  },
  failed: {
    title: '施工失败',
    description: '查看失败详情，决定如何继续。',
    details: '失败详情',
    noDetails: '没有报告失败详情。',
    retry: '重试失败任务',
    replan: '停止并重新规划',
    stopping: '正在停止……',
    replanHint: '停止运行后，结合失败上下文修改蓝图。',
  },
  signOff: {
    title: '检查并验收',
    baseBranch: '基准分支',
    baseSha: '启动时基准提交',
    startSha: '本次起始提交',
    resultSha: '本次结果提交',
    currentBaseSha: '当前基准提交',
    mergedSha: '合并提交',
    parentRun: '上一次运行',
    currentRun: '当前运行',
    approve: '验收并合并',
    merging: '正在合并……',
    merged: '改动已合并。',
    reintegrated: '改动已与更新后的基准整合，检查已通过。',
    gateFailed: '整合后的检查失败，基准分支未更新。',
    conflict: '改动与当前基准存在冲突。',
    changedFiles: '改动文件',
    gates: '检查',
    noGates: '未配置额外检查。',
  },
  revision: {
    title: '提出修改',
    note: '描述需要修改的内容',
    placeholder: '需要修改什么？',
    submit: '开始修改',
    submitting: '正在开始修改……',
    required: '请描述需要修改的内容。',
    created: '修改任务已启动。',
    context: '之前的失败上下文',
    parent: '上一次运行',
    child: '修改后的运行',
    inheritedWorkflow: '修订沿用上一次运行的工作流和团队，服务端会再次检查其就绪状态。',
  },
  rollback: {
    title: '回退改动',
    mode: '选择恢复范围',
    revertRevision: '撤销最近一次修改',
    revertRevisionHint: '将未合并的运行分支移回上一次修改的结果。',
    abandonAll: '放弃全部修改',
    abandonAllHint: '将未合并的运行分支移回最初的起始提交。',
    undo: '撤销已合并改动',
    undoHint: '当合并提交仍为分支头时，将基准分支恢复到合并前的提交。',
    serverChecksHead: '撤销合并前，服务端会检查当前分支头。',
    confirm: '确认回退',
    cancel: '取消',
    working: '正在回退……',
    restored: '已恢复到提交',
    paused: '回退后运行已暂停，可以继续运行或重新规划蓝图。',
    moved: '基准分支已有新提交，请查看建议的撤销方式。',
  },
  drift: {
    title: '基准分支发生变化',
    description: '合并前将改动与当前基准整合，并重新运行检查。',
    conflict: '请先解决列出的冲突，再重试。',
    gateFailed: '请检查失败的检查项后重试。',
    baseMoved: '验收期间基准分支发生变化，请重试以检查最新提交。',
    branchMoved: '验收期间运行发生变化，请刷新后重试。',
    dirty: '验收前请提交或暂存工作区改动。',
  },
  session: {
    loading: '正在加载会话……',
    loadFailed: '无法加载会话。',
    saveFailed: '无法保存会话，请重试后再继续。',
    retrySave: '重试保存',
    reset: '开始新会话',
    resetConfirm: '丢弃已保存草稿并开始新会话？已有运行不会因此停止。',
    cancel: '取消',
    confirmReset: '丢弃并重置',
  },
  errors: {
    RUN_SUPERSEDED: '此运行已被新的运行替代。',
    RUN_STALE: '运行状态已变化，请刷新后重试。',
    RUN_BUSY: '运行正忙，请等待当前操作完成。',
    STOP_PENDING: '停止请求仍在处理中，请等待任务停止后重试。',
    INTEGRATION_CONFLICT: '结果与当前基准存在冲突。',
    GATE_FAILED: '整合后的检查失败。',
    GATE_EXECUTION_FAILED: '整合后的检查无法运行。',
    INVALID_GATES: '无法读取已配置的检查。',
    BASE_MOVED: '验收期间基准发生变化，请重新验收。',
    BASE_CHECKED_OUT: '基准分支已在其他工作树中检出。',
    DIRTY_WORKTREE: '请先提交或暂存工作区改动。',
    MERGE_NOT_HEAD: '基准分支已有后续提交，请查看撤销建议。',
    LAUNCH_KEY_CONFLICT: '此启动请求属于另一次运行。',
    LAUNCH_FAILED: '无法启动施工。',
    REVISION_FAILED: '无法启动修改任务。',
    INTEGRATION_FAILED: '无法整合运行结果。',
    GIT_ERROR: '版本控制操作失败。',
    LAUNCH_PREFLIGHT: '所选工作流已不再就绪。',
    READINESS_UNAVAILABLE: '无法检查供应方是否就绪。',
    SESSION_IO_ERROR: '无法读取或保存会话。',
    BRAINSTORM_SESSION_CHANGED: '本轮进行期间会话发生变化，请重新加载后再试。',
    unknown: '操作失败，请查看详情后重试。',
  },
};

type CredentialKey = 'GEMINI_API_KEY' | 'DEEPSEEK_API_KEY' | 'OPENAI_API_KEY' | 'OPENCODE_API_KEY' | 'ANTHROPIC_API_KEY';

export const ATTENTION_TITLE_KEYS = {
  waiting_human: 'waitingHuman',
  ready_for_final_gate: 'readyForFinalGate',
  failed: 'failed',
  paused: 'paused',
  long_cooldown: 'longCooldown',
} as const satisfies Record<AttentionCategory, string>;

type AttentionTitleKey = (typeof ATTENTION_TITLE_KEYS)[AttentionCategory];

export interface Messages {
  docTitle: string;
  header: {
    localConnected: string;
    standaloneDemo: string;
    languageAria: string;
    guideButton: string;
    switchToLight: string;
    switchToDark: string;
    soundButtonAria: string;
    soundTitle: string;
    soundToggleLabel: string;
    soundVolumeLabel: string;
    soundPreview: string;
    soundOn: string;
    soundOff: string;
    modeLive: string;
    modeReplay: string;
    studioModeAria: string;
  };
  tabs: {
    ariaLabel: string;
    canvas: string;
    sidebar: string;
    inspector: string;
  };
  splitPane: {
    sidebarHandleLabel: string;
    inspectorHandleLabel: string;
    resizeHint: string;
  };
  sidebar: {
    presetsTitle: string;
    nodePaletteTitle: string;
    importExportTitle: string;
    importButton: string;
    exportButton: string;
    shareButton: string;
    validationTitle: string;
    notValidated: string;
    valid: string;
    validWithWarnings(count: number): string;
    invalidWithErrors(count: number): string;
    presetCounts(nodes: number, edges: number): string;
    difficulty: Record<string, string>;
    roleMustBeString(index: number): string;
    liveRunTitle: string;
    liveRunHint: string;
    liveRunTasks(passed: number, total: number): string;
    liveRunActiveBadge: string;
  };
  transfer: {
    sectionTitle: string;
    sectionSubtitle: string;
    recipeBadge: string;
    caseBadge: string;
    importCard: { title: string; desc: string };
    exportRecipeCard: { title: string; desc: string };
    exportCaseCard: { title: string; desc: string };
    importModal: {
      title: string;
      dropHint: string;
      pasteLabel: string;
      detectRecipe: string;
      detectCase: string;
      invalid: string;
      nodes: string;
      edges: string;
      duration: string;
      tasks: string;
      validationOk: string;
      validationFail: string;
      redactionClean: string;
      redactionWarn: string;
      applyRecipe: string;
      loadCase: string;
      overwriteWarning: string;
    };
    exportRecipeModal: {
      title: string;
      assurance: string;
      liveAdvisory: string;
      switchToCase: string;
      download: string;
      copyJson: string;
      copyLink: string;
      copied: string;
      previewToggle: string;
      counts(nodes: number, edges: number): string;
      manualCopyHint: string;
    };
    exportCaseModal: {
      title: string;
      titleLabel: string;
      includeReviews: string;
      anonymize: string;
      checklistTitle: string;
      secrets: string;
      paths: string;
      emails: string;
      ips: string;
      diffs: string;
      stacks: string;
      verifiedClean: string;
      notClean: string;
      download: string;
      copyJson: string;
      copied: string;
      defaultTitle: string;
      previewReplay: string;
      loading: string;
      error: string;
    };
    playback: {
      tutorialTooltip: string;
      startPrefix: string;
      switcherLabel: string;
      importAnother: string;
      resetTutorial: string;
      summaryPill(
        elapsed: string,
        passed: number,
        total: number,
        options?: { separator?: string; clean?: boolean },
      ): string;
    };
    liveRun: { shareCase: string };
  };
  nodeTypes: Record<NodeType, string>;
  nodeStates: Partial<Record<ExecutionState, string>>;
  nodeCard: {
    parallelWorkersTitle: string;
  };
  liveClock: {
    live: string;
    liveBadgeLabel: string;
  };
  attention: Record<AttentionTitleKey, string> & {
    humanAttentionRequired: string;
    approve: string;
    reject: string;
    resume: string;
    viewBattleReport: string;
    enableDesktopAlerts: string;
    notificationsEnabled: string;
    notificationsBlocked: string;
    dismiss: string;
    rejectNotePlaceholder: string;
    fallbackDetails: Record<AttentionCategory, string>;
    docTitlePrefix: string;
    badges: Record<AttentionCategory, string>;
  };
  playback: {
    scenarioAria: string;
    scenarios: Record<Scenario, string>;
    replayButton: string;
    replayTitle: string;
    exitReplay: string;
    backToBlueprint: string;
    liveBanner(runId: string): string;
    play: string;
    pause: string;
    stepBack: string;
    stepForward: string;
    reset: string;
    speedAria(speed: number): string;
    stepCount(step: number, total: number): string;
    ready: string;
    traceKinds: Record<TraceKind, string>;
  };
  inspector: {
    asideAria: string;
    tablistAria: string;
    tabInspector: string;
    tabTrace: string;
    detailsId: string;
    detailsName: string;
    detailsDifficulty: string;
    detailsDescription: string;
    detailsNodes: string;
    detailsEdges: string;
    emptyHint: string;
    openTraceLive: string;
    nodeHeadingPrefix: string;
    edgeHeadingPrefix: string;
    fields: {
      label: string;
      role: string;
      provider: string;
      model: string;
      maxLoops: string;
      sourceHandle: string;
      targetHandle: string;
    };
    saveHotReload: string;
    canvasImmediateNote: string;
    demoHotSwapHintPrefix: string;
    demoHotSwapHintSuffix: string;
    traceTitle: string;
    traceAria: string;
    noTrace: string;
    liveSectionAria: string;
    liveTitle: string;
    reconnecting: string;
    runSyncing: string;
    runSyncFailed: string;
    runHistoryLabel: string;
    runHistoryOption(id: string, status: string, passed: number, total: number, elapsed: string): string;
    stageTimingTitle: string;
    modelRuntimeTitle: string;
    billingTitle: string;
    billingTotalCost(usd: string): string;
    billingTokens(prompt: string, completion: string, cached: string): string;
    billingPerModel(prompt: string, completion: string): string;
    billingExactBadge: string;
    totalElapsed(elapsed: string): string;
    estimatedTag: string;
    callCount(count: number): string;
    avgDuration(avg: string): string;
    taskDetailHint: string;
    taskDetailTitle: string;
    taskDetailModel: string;
    taskDetailDuration: string;
    taskDetailCounters(heal: number, reject: number, escalated: number): string;
    taskDetailFiles: string;
    taskDetailLastError: string;
    taskDetailEvents: string;
    taskDetailNoEvents: string;
    startRealRun: string;
    battleReport: string;
    pauseRun: string;
    resumeRun: string;
    decisionNote: string;
    approve: string;
    reject: string;
    tasksAria: string;
    table: {
      id: string;
      title: string;
      tier: string;
      status: string;
      assignee: string;
    };
    noTasks: string;
    noRuns: string;
    runStatuses: Record<string, string>;
    eventLogTitle: string;
    eventLogAria: string;
    mergeConflictEventKinds: {
      merge_conflict_detected: string;
      merge_conflict_resolved: string;
      merge_conflict_failed: string;
    };
    noEvents: string;
    originalNote: string;
    planningStageLabel: string;
    /** LiveRunPanel stage label for the 00_PANEL phase. */
    panelStageLabel: string;
    /** Live-graph node labels for panel-mode runs. */
    liveGraphNodes: {
      specialist: string;
      synthesizer: string;
    };
    modalReportTitle: string;
    reportRendered: string;
    reportRaw: string;
    reportCopy: string;
    copiedInline: string;
    rfcSourceLegend: string;
    rfcMarkdownOption: string;
    rfcRepoPathOption: string;
    rfcMarkdownAria: string;
    rfcRepoPathAria: string;
    runModeLabel: string;
    runModes: {
      overnight: string;
      interactive: string;
    };
    cancel: string;
    startRun: string;
    errors: {
      enterRelativePath: string;
    };
    modalCloseAria: string;
  };
  toasts: {
    imported(name: string): string;
    loadedShared(name: string): string;
    invalidShared(reason: string): string;
    shareCopied: string;
    shareUpdatedBar: string;
    replayLoaded: string;
    unknownPreset(id: string): string;
    savedRole(role: string, model: string): string;
    reportCopied: string;
  };
  quickStart: {
    title: string;
    subtitle: string;
    tablistAria: string;
    tabQuickStart: string;
    tabLegend: string;
    tabTutorial: string;
    steps: {
      tryStarterTitle: string;
      tryStarterDesc: string;
      watchReplayTitle: string;
      watchReplayDesc: string;
      inspectNodeTitle: string;
      inspectNodeDesc: string;
    };
    tutorialChapters: readonly {
      title: string;
      summary: string;
      points: readonly string[];
    }[];
    legendTiersTitle: string;
    legendTiers: readonly { key: string; name: string; desc: string }[];
    legendEdgesTitle: string;
    legendEdges: readonly { tone: 'normal' | 'retry' | 'escalate'; name: string; desc: string }[];
    shortcutsTitle: string;
    shortcuts: readonly { keys: string; desc: string }[];
    dontShowAgain: string;
    getStarted: string;
  };
  tour: {
    startTourButton: string;
    startTourBanner: string;
    stepProgress(current: number, total: number): string;
    next: string;
    prev: string;
    skip: string;
    finish: string;
    clickHint: string;
    steps: Record<TourStepId, { title: string; description: string; hint: string }>;
  };
  tutorialDiagrams: {
    relayCaption: string;
    relayAria: string;
    guidedFlowCaption: string;
    guidedFlowAria: string;
    sandboxCaption: string;
    sandboxAria: string;
    l0User: string;
    l1Planner: string;
    l3Workers: string;
    mechanicalGate: string;
    l2Reviewer: string;
    finalMerge: string;
    budgetRecipe: string;
    wizardGuards: string;
    liveSync: string;
    bilingualReport: string;
    worktrees: string;
    whitelistRevert: string;
    mainBranch: string;
  };
  recipePlaza: {
    title: string;
    filters: Record<'all' | 'ready_on_host' | Exclude<PresetCategory, 'general'>, string>;
    hostReady: string;
    hostMissing: string;
    costTiers: Record<CostTier, string>;
  };
  budgetProfile: {
    label: string;
    options: Record<BudgetProfile, { label: string; tooltip: string }>;
  };
  pricing: {
    title: string;
    openButton: string;
    syncButton: string;
    lastSynced: string;
    neverSynced: string;
    autoSyncEvery24h: string;
    stale: string;
    syncing: string;
    syncFailed: string;
    columns: Record<'model' | 'source' | 'input' | 'cached' | 'output' | 'actions', string>;
    unit: string;
    sourceCustom: string;
    sourceOfficialCache: string;
    sourceBuiltin: string;
    edit: string;
    save: string;
    cancel: string;
    resetToOfficial: string;
    invalidNumber: string;
    saved: string;
    saveFailed: string;
    close: string;
    searchLabel: string;
    searchPlaceholder: string;
    clearSearch: string;
    searchCount(shown: number, total: number): string;
    noMatches: string;
  };
  nodeReadiness: {
    statuses: Record<'ready' | 'cooldown' | 'missing', string>;
    doctorButton: string;
    doctorTimeout: string;
    latency(milliseconds: number): string;
    installHint: string;
    dshInstallHint: string;
    pinModelOverride: string;
  };
  credentials: {
    title: string;
    keyLabels: Record<CredentialKey, string>;
    save: string;
    clear: string;
  };
  wizard: {
    fields: {
      goal: string;
      constraints: string;
    };
    readinessScore(score: number): string;
    warnings: {
      title: string;
      missingSections: string;
      missingVerificationCommand: string;
      unsafeForOvernight: string;
      ambiguityMarker(marker: string): string;
      questionInHeading: string;
      shortGoal: string;
      unnumberedAcceptance: string;
    };
    runModes: Record<'overnight' | 'interactive', string>;
  };
  guided: {
    m3: GuidedM3Messages;
    mode: { guided: string; pro: string };
    steps: readonly { title: string; hint: string }[];
    workbench: {
      stepsAria: string;
      waitingForRun: string;
      nodeHint: string;
      pausedBanner: string;
      resumeRun: string;
      newBlueprint: string;
      changeTeam: string;
      currentTeamPrefix: string;
    };
    setup: {
      pickFolder: string;
      applyPath: string;
      currentFolder: string;
      browsing: string;
      switchingFolder: string;
      initializingGit: string;
      gitReady: string;
      gitMissing: string;
      initGit: string;
      firstCommitMissing: string;
      createFirstCommit: string;
      creatingFirstCommit: string;
      firstCommitDone: string;
      continueNeedsHistory: string;
      scanClis: string;
      scanning: string;
      scanSummary: (ready: number, total: number) => string;
      filterAll: string;
      filterReady: string;
      filterNeedsSetup: string;
      install: string;
      installing: string;
      installConsent: string;
      login: string;
      openingLogin: string;
      needsLogin: string;
      ready: string;
      missing: string;
      tiers: { official: string; community: string };
      lineupReady: string;
      lineupMissing: string;
      presetRecommended: string;
      presetAllProvider: (provider: string) => string;
      customizeRoles: string;
      hideCustomizeRoles: string;
      resetLineup: string;
      customBadge: string;
      useLineup: string;
      useCustomLineup: string;
      savedProfilesTitle: string;
      saveProfilePlaceholder: string;
      saveProfileButton: string;
      savingProfile: string;
      profileSaved(name: string): string;
      profileApplied(name: string): string;
      deleteProfileAria(name: string): string;
      lastUsedBadge: string;
      lastUsedNamedBadge(name: string): string;
      installedDone: string;
      folderSelected: string;
      gitEnabledDone: string;
      effortUnverified: string;
      effortUnverifiedTitle: string;
      savedTeamCorrected: (changes: string) => string;
      apiKeysTitle: string;
      apiKeysSummary: (configured: number, total: number) => string;
      apiKeysShow: string;
      apiKeysHide: string;
      apiKeysNote: string;
      apiKeyPlaceholder: string;
      apiKeySaving: string;
      apiKeySaved: string;
      apiKeyEnvSource: string;
      apiKeyMissing: string;
      needsApiKeyForTeam: (envKey: string) => string;
      configureApiKeyAction: string;
      teamNeedsApiKeyNote: (names: string, keys: string) => string;
      syncModels: string;
      syncingModels: string;
      modelsSyncedDone: (added: number) => string;
      modelsDailyHint: string;
      modelsSyncFailed: string;
      providerColumnLabel: string;
      modelColumnLabel: string;
      effortColumnLabel: string;
      modelGroupLatest: string;
      modelGroupLegacy: string;
      effortUnsupported: string;
    };
    brainstorm: {
      openTitle: string;
      openHint: string;
      examplesTitle: string;
      moreExamples: string;
      inputPlaceholder: string;
      inputHint: string;
      send: string;
      notSure: string;
      typewriter: string;
      restart: string;
      waitUnderstanding: string;
      waitDrafting: string;
      waitSlow: string;
      blueprintTitle: string;
      emptyCard: string;
      progress: (clear: number, total: number) => string;
      progressAssumed: (count: number) => string;
      items: { what: string; who: string; scope: string; limits: string; done: string };
      statuses: { clear: string; assumed: string; open: string };
      editItem: string;
      editPrefill: (item: string) => string;
      assumptionsTitle: string;
      notReadyMissing: (items: string) => string;
      notReadyCheck: string;
      notReadyLineup: string;
      offlineNotice: string;
      liveFailed: (reason: string) => string;
      retry: string;
      confirmLaunch: string;
      launching: string;
      showRfc: string;
      hideRfc: string;
    };
    /** The Blueprint fast lane for people who already have their RFC written. */
    pasteRfc: {
      title: string;
      hint: string;
      switchToPaste: string;
      switchToChat: string;
      previewTitle: string;
      previewEmpty: string;
      recommending: string;
      recommendFailed: string;
      retry: string;
      dropTooLarge: string;
      dropNotText: string;
    };
    nodeDetail: {
      title: string;
      summary: string;
      model: string;
      elapsed: string;
      cost: string;
      tests: string;
      changedFiles: string;
      verdict: string;
      close: string;
      statuses: Record<string, string>;
      testStatuses: Record<string, string>;
      verdicts: Record<string, string>;
    };
    decision: {
      title: string;
      intro: string;
      submit: string;
      submitting: string;
      noteLabel: string;
    };
    signOff: {
      title: string;
      testsPassed: string;
      testsSummary(passed: number, total: number): string;
      changedFiles: string;
      battleReport: string;
      approve: string;
      revise: string;
      reviseNote: string;
      rollback: string;
      working: string;
      rollbackHint: string;
      rollbackConfirm: string;
      done: string;
      revisedDone: string;
      rolledBackDone: string;
      kpiTests: string;
      kpiFiles: string;
      kpiCost: string;
      kpiCostUnavailable: string;
      workspaceLocation: string;
      openFolder: string;
      openFile: string;
      revealFile: string;
      openFailed: string;
      deliverablesTitle: string;
      deliverablesEmpty: string;
      battleReportInline: string;
      battleReportToggleShow: string;
      battleReportToggleHide: string;
      battleReportLoading: string;
      battleReportFailed: string;
      copyReport: string;
      copiedReport: string;
    };
    errors: {
      dirtyWorkingTree: string;
      notReadyForFinalGate: string;
      rollbackRequiresCompleted: string;
      rollbackMovedPastMerge: string;
      emptyReviseNote: string;
      requestTimedOut: string;
    };
  };
  glossary: {
    open: string;
    title: string;
    all: string;
    close: string;
    search: string;
    plain: string;
    pro: string;
    related: string;
    empty: string;
  };
}

export const MESSAGES: Record<Locale, Messages> = {
  en: {
    docTitle: 'VibeBaton — Multi-Agent Workflow Canvas',
    header: {
      localConnected: 'Local Connected',
      standaloneDemo: 'Standalone Demo',
      languageAria: 'Interface language',
      guideButton: 'Guide',
      switchToLight: 'Switch to light theme',
      switchToDark: 'Switch to dark theme',
      soundButtonAria: 'Liquid sound effects settings',
      soundTitle: 'Liquid Sound',
      soundToggleLabel: 'Sound Effects',
      soundVolumeLabel: 'Volume',
      soundPreview: 'Preview',
      soundOn: 'On',
      soundOff: 'Off',
      modeLive: 'Live',
      modeReplay: 'Replay',
      studioModeAria: 'Studio mode',
    },
    tabs: {
      ariaLabel: 'Workspace views',
      canvas: 'Canvas',
      sidebar: 'Sidebar',
      inspector: 'Inspector',
    },
    splitPane: {
      sidebarHandleLabel: 'Resize sidebar',
      inspectorHandleLabel: 'Resize inspector',
      resizeHint: 'Double-click to reset the pane width.',
    },
    sidebar: {
      presetsTitle: 'Presets',
      nodePaletteTitle: 'Node Palette',
      importExportTitle: 'Import / Export',
      importButton: 'Import .baton.json',
      exportButton: 'Export JSON',
      shareButton: 'Share Link',
      validationTitle: 'Validation',
      notValidated: 'Not validated',
      valid: 'Valid',
      validWithWarnings: (count) => `Valid · ${count} warnings`,
      invalidWithErrors: (count) => `Invalid · ${count} errors`,
      presetCounts: (nodes, edges) => `${nodes} nodes · ${edges} edges`,
      difficulty: {
        beginner: 'Beginner',
        intermediate: 'Intermediate',
        pro: 'Pro',
        expert: 'Expert',
        live: 'Live',
      },
      roleMustBeString: (index) => `nodes[${index}].role must be a string`,
      liveRunTitle: 'Live Run Workflow',
      liveRunHint: 'Click to view real milestones & tasks on canvas',
      liveRunTasks: (passed, total) => `${passed}/${total} tasks`,
      liveRunActiveBadge: 'Live Sync',
    },
    transfer: {
      sectionTitle: 'Save, Import & Share',
      sectionSubtitle: 'Recipes (.baton.json) save workflows. Run cases (.baton-case.json) replay recorded runs.',
      recipeBadge: 'Recipe',
      caseBadge: 'Run case',
      importCard: {
        title: 'Import Recipe or Case',
        desc: 'Load a file or paste JSON or a recipe link.',
      },
      exportRecipeCard: {
        title: 'Export Recipe',
        desc: 'Save or share the current workflow.',
      },
      exportCaseCard: {
        title: 'Export Run Case',
        desc: 'Create a replay case with sensitive details removed.',
      },
      importModal: {
        title: 'Import Recipe or Case',
        dropHint: 'Drop a .baton.json or .baton-case.json file here, or choose a file.',
        pasteLabel: 'Paste JSON or a recipe link',
        detectRecipe: 'Recipe detected',
        detectCase: 'Run case detected',
        invalid: 'Enter a valid recipe, case, or recipe link.',
        nodes: 'Nodes',
        edges: 'Edges',
        duration: 'Duration',
        tasks: 'Tasks',
        validationOk: 'Validation passed',
        validationFail: 'Validation failed',
        redactionClean: 'Redaction verified',
        redactionWarn: 'Review redaction',
        applyRecipe: 'Apply Recipe to Canvas',
        loadCase: 'Load & Replay Case',
        overwriteWarning: 'Continuing will replace the current canvas.',
      },
      exportRecipeModal: {
        title: 'Export Recipe',
        assurance: 'Recipes save workflow structure and model routing.',
        liveAdvisory: 'To share a replay of this run, export a run case.',
        switchToCase: 'Export Run Case',
        download: 'Download .baton.json',
        copyJson: 'Copy JSON',
        copyLink: 'Copy Recipe Link',
        copied: 'Copied to clipboard',
        previewToggle: 'JSON preview',
        counts: (nodes, edges) => `${nodes} ${nodes === 1 ? 'node' : 'nodes'} · ${edges} ${edges === 1 ? 'edge' : 'edges'}`,
        manualCopyHint: 'Copy the selected text below.',
      },
      exportCaseModal: {
        title: 'Export Run Case',
        titleLabel: 'Case title',
        includeReviews: 'Include sanitized review summaries',
        anonymize: 'Anonymize run ID',
        checklistTitle: 'Redaction Checklist',
        secrets: 'Secrets redacted',
        paths: 'Paths anonymized',
        emails: 'Emails redacted',
        ips: 'Private IP addresses redacted',
        diffs: 'Raw diffs removed',
        stacks: 'Stack traces removed',
        verifiedClean: 'Redaction verified',
        notClean: 'Review redaction before sharing',
        download: 'Download .baton-case.json',
        copyJson: 'Copy Case JSON',
        copied: 'Copied',
        defaultTitle: 'Run replay',
        previewReplay: 'Preview in Replay Player',
        loading: 'Preparing run case...',
        error: 'Could not prepare the run case.',
      },
      playback: {
        tutorialTooltip: 'Practice playback with Stage 1. Choose Import Recipe or Case to open a shared .baton-case.json file.',
        startPrefix: 'Start: ',
        switcherLabel: 'Choose a replay case',
        importAnother: 'Import Another Case',
        resetTutorial: 'Return to Stage 1 Tutorial',
        summaryPill: (elapsed, passed, total, { separator = ' | ', clean = true } = {}) =>
          [elapsed, `${passed}/${total} tasks`, clean ? 'sanitized replay' : 'review redaction'].join(separator),
      },
      liveRun: { shareCase: 'Share Case' },
    },
    nodeTypes: {
      planner_node: 'Planner',
      router_node: 'Router',
      worker_node: 'Worker',
      gate_node: 'Gate',
      reviewer_node: 'Reviewer',
      merge_node: 'Merge',
      human_gate_node: 'Human Gate',
    },
    nodeStates: {
      active: '● RUN',
      retrying: '↻ RETRY',
      escalated: '▲ ESC',
      passed: '✓ OK',
      failed: '✕ FAIL',
    },
    nodeCard: {
      parallelWorkersTitle: 'Parallel workers',
    },
    liveClock: {
      live: 'LIVE',
      liveBadgeLabel: 'Live timer running',
    },
    attention: {
      humanAttentionRequired: 'Human Attention Required',
      waitingHuman: 'Human decision required',
      readyForFinalGate: 'Ready for final gate',
      failed: 'Run failed',
      paused: 'Run paused',
      longCooldown: 'Provider quota cooldown',
      approve: 'Approve',
      reject: 'Reject',
      resume: 'Resume',
      viewBattleReport: 'View Battle Report',
      enableDesktopAlerts: 'Enable Desktop Alerts',
      notificationsEnabled: 'Desktop alerts enabled',
      notificationsBlocked: 'Desktop alerts blocked',
      dismiss: 'Dismiss',
      rejectNotePlaceholder: 'Reason for rejection',
      fallbackDetails: {
        waiting_human: 'The run is waiting for a human decision.',
        ready_for_final_gate: 'All milestones passed and the run is ready for final review.',
        failed: 'The run stopped because of an error.',
        paused: 'The run is paused.',
        long_cooldown: 'A task is waiting for its provider quota to recover.',
      },
      docTitlePrefix: '[⚠ ',
      badges: {
        waiting_human: 'Human decision',
        ready_for_final_gate: 'Final gate',
        failed: 'Failed',
        paused: 'Paused',
        long_cooldown: 'Quota cooldown',
      },
    },
    playback: {
      scenarioAria: 'Scenario',
      scenarios: {
        happy_path: 'Happy Path',
        gate_retry: 'Gate Retry',
        escalate: 'Escalate',
      },
      replayButton: 'Tutorial: Stage 1 (60×)',
      replayTitle: 'Replay real Stage 1 self-hosting run (run-20261121-044454-3b1845 · 107m @ 60×)',
      exitReplay: 'Exit Replay',
      backToBlueprint: 'Back to Blueprint',
      liveBanner: (runId) => `Live Sync · ${runId}`,
      play: 'Play',
      pause: 'Pause',
      stepBack: 'Step back',
      stepForward: 'Step forward',
      reset: 'Reset playback',
      speedAria: (speed) => `Playback speed ${speed}x`,
      stepCount: (step, total) => `Step ${step} / ${total}`,
      ready: 'Ready',
      traceKinds: {
        node_started: 'Node started',
        node_completed: 'Node completed',
        node_failed: 'Node failed',
        edge_traversed: 'Edge traversed',
        loop_limit_reached: 'Loop limit reached',
        graph_completed: 'Workflow completed',
        graph_halted: 'Workflow halted',
      },
    },
    inspector: {
      asideAria: 'Workflow inspector',
      tablistAria: 'Workflow inspector views',
      tabInspector: 'Inspector',
      tabTrace: 'Trace & Live Run',
      detailsId: 'ID',
      detailsName: 'Name',
      detailsDifficulty: 'Difficulty',
      detailsDescription: 'Description',
      detailsNodes: 'Nodes',
      detailsEdges: 'Edges',
      emptyHint: 'Click any node or edge on the canvas to inspect or hot-swap its model.',
      openTraceLive: 'Open Trace & Live Run',
      nodeHeadingPrefix: 'Node',
      edgeHeadingPrefix: 'Edge',
      fields: {
        label: 'Label',
        role: 'Role',
        provider: 'Provider',
        model: 'Model',
        maxLoops: 'Max Loops',
        sourceHandle: 'Source Handle',
        targetHandle: 'Target Handle',
      },
      saveHotReload: 'Save to baton.toml (Hot-Reload)',
      canvasImmediateNote: 'Field edits update the canvas recipe immediately. Saving writes global role defaults to baton.toml.',
      demoHotSwapHintPrefix: 'Run ',
      demoHotSwapHintSuffix: ' locally to hot-swap models',
      traceTitle: 'Trace',
      traceAria: 'Simulation trace',
      noTrace: 'No trace yet.',
      liveSectionAria: 'Live run',
      liveTitle: 'Live Run',
      reconnecting: 'reconnecting…',
      runSyncing: 'Loading selected run…',
      runSyncFailed: 'Selected run failed to load. Refresh or choose another run.',
      runHistoryLabel: 'Run History',
      runHistoryOption: (id, status, passed, total, elapsed) => `${id} · ${status} (${passed}/${total} · ${elapsed})`,
      stageTimingTitle: 'Stage Timing',
      modelRuntimeTitle: 'Model Runtime',
      billingTitle: 'Token Usage & Cost',
      billingTotalCost: (usd) => `Total cost ${usd}`,
      billingTokens: (prompt, completion, cached) => `Prompt ${prompt} · Completion ${completion} · Cached ${cached}`,
      billingPerModel: (prompt, completion) => `Prompt ${prompt} · Completion ${completion}`,
      billingExactBadge: 'Exact billing',
      totalElapsed: (elapsed) => `Total: ${elapsed}`,
      estimatedTag: 'est.',
      callCount: (count) => `${count} calls`,
      avgDuration: (avg) => `avg ${avg}`,
      taskDetailHint: 'Click any task row to inspect gates, files, and audit logs',
      taskDetailTitle: 'Task Audit Details',
      taskDetailModel: 'Assigned Model',
      taskDetailDuration: 'Duration',
      taskDetailCounters: (heal, reject, escalated) => `Self-heal ${heal} · Review fix ${reject} · Escalations ${escalated}`,
      taskDetailFiles: 'Allowed Files',
      taskDetailLastError: 'Latest Gate / Error Note',
      taskDetailEvents: 'Task Audit Events',
      taskDetailNoEvents: 'No task-specific audit events recorded.',
      startRealRun: 'Go to Guided mode to start a run',
      battleReport: 'Battle Report',
      pauseRun: 'Pause',
      resumeRun: 'Resume',
      decisionNote: 'Decision note (optional)',
      approve: 'Approve',
      reject: 'Reject',
      tasksAria: 'Run tasks',
      table: {
        id: 'ID',
        title: 'Title',
        tier: 'Tier',
        status: 'Status',
        assignee: 'Assignee',
      },
      noTasks: 'No tasks yet.',
      noRuns: 'No runs yet.',
      runStatuses: {
        PLANNING: 'Planning',
        IN_PROGRESS: 'In Progress',
        REVIEWING: 'Reviewing',
        GATE_CHECKING: 'Gate Checking',
        COOLDOWN: 'Quota Cooldown',
        RUNNING: 'Running',
        PAUSED: 'Paused',
        WAITING_HUMAN: 'Waiting for Human',
        READY_FOR_FINAL_GATE: 'Ready for Final Gate',
        COMPLETED: 'Completed',
        FAILED: 'Failed',
        HALTED: 'Halted',
        PASSED: 'Passed',
        PENDING: 'Pending',
        REJECTED: 'Rejected',
        CANCELLED: 'Cancelled',
        ESCALATED: 'Escalated',
        UNKNOWN: 'Unknown',
      },
      eventLogTitle: 'Event Log',
      eventLogAria: 'Run event log',
      mergeConflictEventKinds: {
        merge_conflict_detected: 'Merge Conflict Detected',
        merge_conflict_resolved: 'Merge Conflict Resolved',
        merge_conflict_failed: 'Merge Conflict Resolution Failed',
      },
      noEvents: 'No events yet.',
      originalNote: 'Original note',
      planningStageLabel: '01_PLAN',
      panelStageLabel: 'Specialist Panel',
      liveGraphNodes: {
        specialist: 'Specialist',
        synthesizer: 'Synthesizer',
      },
      modalReportTitle: 'Battle Report',
      reportRendered: 'Rendered',
      reportRaw: 'Raw Markdown',
      reportCopy: 'Copy Markdown',
      copiedInline: 'Copied',
      rfcSourceLegend: 'RFC source',
      rfcMarkdownOption: 'RFC markdown',
      rfcRepoPathOption: 'Repo path',
      rfcMarkdownAria: 'RFC markdown',
      rfcRepoPathAria: 'Repo path',
      runModeLabel: 'Mode',
      runModes: {
        overnight: 'overnight',
        interactive: 'interactive',
      },
      cancel: 'Cancel',
      startRun: 'Start Run',
      errors: {
        enterRelativePath: 'Enter a path relative to the repository.',
      },
      modalCloseAria: 'Close dialog',
    },
    toasts: {
      imported: (name) => `Imported ${name}`,
      loadedShared: (name) => `Loaded shared recipe: ${name}`,
      invalidShared: (reason) => `Invalid shared recipe link: ${reason}`,
      shareCopied: 'Shareable link copied to clipboard',
      shareUpdatedBar: 'Shareable URL updated in address bar',
      replayLoaded: 'Stage 1 Real Run (v0.2.0 · 107m @ 60×) loaded',
      unknownPreset: (id) => `Unknown preset '${id}'`,
      savedRole: (role, model) => `Saved ${role} -> ${model} (hot-reloaded)`,
      reportCopied: 'Battle report copied to clipboard',
    },
    quickStart: {
      title: 'Quick Start & Tutorial',
      subtitle: 'Orchestrate multiple AI models like a relay race — click any step below to try it live.',
      tablistAria: 'Guide sections',
      tabQuickStart: 'Quick Start',
      tabLegend: 'Legend & Shortcuts',
      tabTutorial: 'Tutorial',
      steps: {
        tryStarterTitle: '1. Run Starter 2-Tier Flow Demo',
        tryStarterDesc: 'Load the minimal DSH starter workflow and animate Happy Path playback.',
        watchReplayTitle: '2. Watch Stage 1 Real Run (60×)',
        watchReplayDesc: 'Replay how VibeBaton built itself across 3 milestones, catching bugs and auto-escalating.',
        inspectNodeTitle: '3. Inspect & Hot-Swap Models',
        inspectNodeDesc: 'Select a worker card on the canvas to edit its provider/model or share via #recipe link.',
      },
      tutorialChapters: [
        {
          title: '1. Plain-Language Architecture (The Relay Race)',
          summary: 'Think of VibeBaton as an automated software factory relay where each AI tier handles what it does best.',
          points: [
            'L0 (You + Architect): Align the goal and constraints up front, then review the Battle Report before merging to main.',
            'L1 (Planner & Milestone Reviewer): Splits the RFC into ordered milestones and verifies every milestone integration.',
            'L3 (DSH Workers): Runs routine modules fast in parallel using isolated Git worktrees and file whitelists.',
            'Mechanical Gate + L2 Reviewer: Deterministic unit tests and lint run first before spending senior review quota.',
          ],
        },
        {
          title: '2. Your First Real Run in 5 Steps',
          summary: 'Go from an idea to verified code cleanly from either the Studio UI or Windows PowerShell.',
          points: [
            'Step 1 — Pick a Budget & Preset: Choose Eco, Balanced, or Max Quality and select a green "Ready on Host" workflow on the left.',
            'Step 2 — Click "Go to Guided mode to start a run": Guided mode checks the workspace and your local tools, then you describe the project in a chat or paste a finished RFC.',
            'Step 3 — Confirm Team, Flow & Budget: The launch card lists the document, each role\'s tool and model, the flow and the project budget; check them, then confirm to start.',
            'Step 4 — Watch Live Canvas Sync: Click the top-left "Live Run Workflow" card to see live tasks glow in real time.',
            'Step 5 — Inspect Battle Report & Sign Off: Check Stage Timing, Model Runtime, and approve L0 merge only when tests pass.',
          ],
        },
        {
          title: '3. Beginner FAQ & Troubleshooting',
          summary: 'Quick answers for first-time builders running VibeBaton locally.',
          points: [
            'Q: Why did the canvas show a static preset while running? Click the top-left "Live Run Workflow" card to switch the canvas to live task nodes.',
            'Q: How do I minimize API spend? Use "Starter 2-Tier Flow" or "DSH Bulk Factory" paired with the Eco budget profile.',
            'Q: What happens on 429 rate limits or timeouts? Only that provider pauses in cooldown while sibling workers continue and stuck tasks auto-escalate.',
            'Q: Is my main branch safe overnight? Yes — work happens inside isolated Git worktrees on dev and awaits human final approval.',
          ],
        },
      ],
      legendTiersTitle: 'Tier Colors & Roles',
      legendTiers: [
        { key: 'L0', name: 'L0 · Brainstorm & Sign-Off', desc: 'Interactive specification alignment and final human gate.' },
        { key: 'L1', name: 'L1 · Planner & Milestone Gate', desc: 'Decomposes RFC into a milestone DAG and audits final delivery.' },
        { key: 'L2', name: 'L2 · Critical & Micro Review', desc: 'Handles core architecture tasks, escalations, and per-task code review.' },
        { key: 'L3', name: 'L3 · Parallel Bulk Workers', desc: 'Runs high-concurrency routine implementation tasks via DSH.' },
        { key: 'GATE', name: 'Mechanical Gate', desc: 'Runs deterministic unit tests & lint checks before spending review quota.' },
        { key: 'MERGE', name: 'Milestone Merge', desc: 'Verifies file whitelists and squash-merges completed worktrees.' },
      ],
      legendEdgesTitle: 'Baton Flow Edge Semantics',
      legendEdges: [
        { tone: 'normal', name: 'Forward / Pass', desc: 'Cyan-emerald animated pulse on normal handoffs and passed gates.' },
        { tone: 'retry', name: 'Self-Heal / Minor Fix', desc: 'Amber loop bounded by max_loops for automated retry or review fixes.' },
        { tone: 'escalate', name: 'Circuit-Breaker Escalate', desc: 'Magenta escalation path handing stuck L3 tasks to L2 specialists.' },
      ],
      shortcutsTitle: 'Shortcuts & Tips',
      shortcuts: [
        { keys: 'Space', desc: 'Play or pause simulation playback' },
        { keys: '← / →', desc: 'Step backward or forward one frame' },
        { keys: 'Delete / Backspace', desc: 'Remove selected canvas node or edge' },
      ],
      dontShowAgain: "Don't show automatically on startup",
      getStarted: 'Get Started',
    },
    tour: {
      startTourButton: 'Start 1-Minute Interactive Tour',
      startTourBanner: 'Follow the highlighted controls to explore the Studio.',
      stepProgress: (current, total) => `Step ${current} / ${total}`,
      next: 'Next',
      prev: 'Back',
      skip: 'Skip',
      finish: 'Finish',
      clickHint: 'Click the highlighted area to continue.',
      steps: {
        'live-run-card': {
          title: 'Live Run Workflow',
          description: 'Follow the selected run and its milestones on the canvas.',
          hint: 'Click the live run card to open its workflow.',
        },
        'budget-profile': {
          title: 'Budget Profile',
          description: 'Set cost and reasoning preferences for local runs.',
          hint: 'Compare Eco, Balanced, and Max Quality.',
        },
        'recipe-plaza': {
          title: 'Recipe Plaza',
          description: 'Browse workflow presets by project type or local readiness.',
          hint: 'Select a preset to load it onto the canvas.',
        },
        'canvas-workspace': {
          title: 'Canvas and Playback',
          description: 'Inspect the workflow graph, play a simulation, or follow a live run.',
          hint: 'Select a node or try the playback controls.',
        },
        'demo-playback': {
          title: 'Stage 1 Replay',
          description: 'Watch the recorded four-tier workflow run without a local server.',
          hint: 'Use Replay to load the recorded run, then step through its events.',
        },
        'inspector-live-tab': {
          title: 'Trace & Live Run',
          description: 'Review simulation events and monitor runs in local mode.',
          hint: 'Open the highlighted tab to view the trace.',
        },
        'start-real-run-btn': {
          title: 'Start a Run',
          description: 'Runs start in Guided mode, which shows the team, flow and budget for you to confirm before anything starts.',
          hint: 'Click the button to go to Guided mode.',
        },
        'header-controls': {
          title: 'Studio Controls',
          description: 'Switch language or theme, adjust audio, and reopen the guide.',
          hint: 'Use Guide to return to the tutorial.',
        },
      },
    },
    tutorialDiagrams: {
      relayCaption: 'The four-tier relay from planning to final approval.',
      relayAria: 'The user sets the goal, the planner defines tasks, DSH workers implement them, and mechanical checks and code review precede final user approval.',
      guidedFlowCaption: 'From budget and recipe selection to the run report.',
      guidedFlowAria: 'Choose a budget and recipe, start the run from Guided mode after checking its team and flow, follow the live run on the canvas, and review the bilingual report before final approval.',
      sandboxCaption: 'Parallel worktrees and path whitelist checks protect the main branch.',
      sandboxAria: 'Workers edit in isolated Git worktrees. The path whitelist guard reverts out-of-scope changes, and merges to the main branch require final approval.',
      l0User: 'L0 (User)',
      l1Planner: 'L1 Planner',
      l3Workers: 'L3 DSH Workers',
      mechanicalGate: 'Mechanical Gate',
      l2Reviewer: 'L2 Reviewer',
      finalMerge: 'L0 Final Merge',
      budgetRecipe: 'Budget + Recipe',
      wizardGuards: 'Guided Launch + Confirm',
      liveSync: 'Live Run + Canvas Sync',
      bilingualReport: 'Bilingual Report + L0 Sign-Off',
      worktrees: 'Isolated Git Worktrees',
      whitelistRevert: 'Path Whitelist Revert',
      mainBranch: 'Protected Main Branch',
    },
    recipePlaza: {
      title: 'Recipe Plaza',
      filters: {
        all: 'All',
        ready_on_host: 'Ready on Host',
        same_family: 'Same-Family',
        bulk_batch: 'Bulk Batch',
        small_project: 'Small Project',
        audit: 'Audit',
        panel: 'Panel & Execute',
      },
      hostReady: 'Ready on Host',
      hostMissing: 'Missing on Host',
      costTiers: { low: 'Low', medium: 'Medium', high: 'High' },
    },
    budgetProfile: {
      label: 'Budget Profile',
      options: {
        eco: { label: 'Eco', tooltip: 'Favor lower-cost models and reasoning settings.' },
        balanced: { label: 'Balanced', tooltip: 'Balance cost and reasoning effort across tasks.' },
        max_quality: { label: 'Max Quality', tooltip: 'Favor the strongest available models and highest reasoning effort.' },
      },
    },
    pricing: {
      title: 'API Pricing',
      openButton: 'API Pricing',
      syncButton: 'Sync Official Prices',
      lastSynced: 'Last synced',
      neverSynced: 'Never synced',
      autoSyncEvery24h: 'Auto-sync every 24 hours',
      stale: 'Cache is stale',
      syncing: 'Syncing prices…',
      syncFailed: 'Could not sync official prices',
      columns: {
        model: 'Model',
        source: 'Source',
        input: 'Input',
        cached: 'Cached Input',
        output: 'Output',
        actions: 'Actions',
      },
      unit: 'USD / 1M tokens',
      sourceCustom: 'Custom',
      sourceOfficialCache: 'Official Cache',
      sourceBuiltin: 'Built-in',
      edit: 'Edit',
      save: 'Save',
      cancel: 'Cancel',
      resetToOfficial: 'Reset to Official',
      invalidNumber: 'Enter a finite, non-negative number.',
      saved: 'Prices saved',
      saveFailed: 'Could not save custom prices',
      close: 'Close',
      searchLabel: 'Search models',
      searchPlaceholder: 'Search model name, e.g. claude, gemini, gpt...',
      clearSearch: 'Clear',
      searchCount: (shown, total) => (shown === total ? `${total} models` : `Showing ${shown} of ${total}`),
      noMatches: 'No models match your search.',
    },
    nodeReadiness: {
      statuses: { ready: 'Ready', cooldown: 'Cooldown', missing: 'Missing' },
      doctorButton: '5s Doctor',
      doctorTimeout: 'Probe timed out after 5 seconds.',
      latency: (milliseconds) => `${milliseconds} ms latency`,
      installHint: 'Setup Hint',
      dshInstallHint: 'Install the DeepSeek Harness CLI and configure your DSH Gateway Key.',
      pinModelOverride: 'Pin model override',
    },
    credentials: {
      title: 'Credentials Setup',
      keyLabels: {
        GEMINI_API_KEY: 'Gemini API Key',
        DEEPSEEK_API_KEY: 'DeepSeek API Key (DSH)',
        OPENAI_API_KEY: 'OpenAI API Key',
        OPENCODE_API_KEY: 'DSH Gateway Key',
        ANTHROPIC_API_KEY: 'Anthropic API Key',
      },
      save: 'Save',
      clear: 'Clear',
    },
    wizard: {
      fields: {
        goal: 'Goal',
        constraints: 'Constraints',
      },
      readinessScore: (score) => `Readiness Score · ${score}/100`,
      warnings: {
        title: 'Warnings',
        missingSections: 'Missing RFC sections',
        missingVerificationCommand: 'Add a verification command to check the run automatically.',
        unsafeForOvernight: 'Resolve the RFC readiness issues before starting an overnight run.',
        ambiguityMarker: (marker) => `Replace the ambiguous marker "${marker}" with a concrete requirement.`,
        questionInHeading: 'Rewrite the question in the RFC heading as a clear requirement.',
        shortGoal: 'Write a goal of at least 40 characters.',
        unnumberedAcceptance: 'Number the acceptance criteria.',
      },
      runModes: { overnight: 'Overnight', interactive: 'Interactive' },
    },
    guided: {
      m3: GUIDED_M3_EN,
      mode: { guided: 'Guided', pro: 'Pro' },
      workbench: {
        stepsAria: 'Guided steps',
        waitingForRun: 'Starting the build. The task map appears as soon as the plan is ready…',
        nodeHint: 'Click any task on the map to see what happened in plain words.',
        pausedBanner: 'The run is paused. You can resume where it stopped or start a new blueprint.',
        resumeRun: 'Resume Run',
        newBlueprint: 'Start New Blueprint',
        changeTeam: 'Workspace & Tools',
        currentTeamPrefix: 'Current team:',
      },
      steps: [
        { title: 'Workspace', hint: 'Choose your project folder and confirm the AI coding tools on this computer.' },
        { title: 'Blueprint', hint: 'Describe what you want to build and shape the plan with your AI architecture partner.' },
        { title: 'Build', hint: 'Watch the AI team plan, write, test, and review each task.' },
        { title: 'Sign-Off', hint: 'Review the result and decide whether it lands on your main branch.' },
      ],
      setup: {
        pickFolder: 'Choose Project Folder',
        applyPath: 'Apply Path',
        currentFolder: 'Current project folder',
        browsing: 'Opening folder picker…',
        switchingFolder: 'Switching project folder and scanning tools…',
        initializingGit: 'Turning on version history…',
        gitReady: 'Version history is on. Every change can be reviewed and undone.',
        gitMissing: 'This folder does not track version history yet. Turn it on so every change can be undone.',
        initGit: 'Turn On Version History',
        firstCommitMissing: 'This project has no first save point yet, so the build cannot start. Create one with a click; your files stay as they are.',
        createFirstCommit: 'Create First Save Point',
        creatingFirstCommit: 'Creating the first save point...',
        firstCommitDone: 'First save point created.',
        continueNeedsHistory: 'Turn on version history above first; the build needs it to start.',
        scanClis: 'Scan AI Coding Tools',
        scanning: 'Scanning this computer…',
        scanSummary: (ready, total) => `${ready}/${total} ready`,
        filterAll: 'All',
        filterReady: 'Ready',
        filterNeedsSetup: 'Needs Setup',
        install: 'Install',
        installing: 'Installing…',
        installConsent: 'Allow VibeBaton to run this install command:',
        login: 'Sign In',
        openingLogin: 'Opening sign-in…',
        needsLogin: 'Sign-in needed',
        ready: 'Ready',
        missing: 'Not installed',
        tiers: { official: 'Official', community: 'Community' },
        lineupReady: 'Your AI team is ready to work.',
        lineupMissing: 'Install or sign in to at least one AI coding tool to form a team.',
        presetRecommended: 'Recommended',
        presetAllProvider: (provider) => `All ${provider}`,
        customizeRoles: 'Customize Roles',
        hideCustomizeRoles: 'Hide Role Editor',
        resetLineup: 'Reset to Recommended',
        customBadge: 'Customized',
        useLineup: 'Continue to Blueprint',
        useCustomLineup: 'Continue with This Team',
        savedProfilesTitle: 'Saved Presets:',
        saveProfilePlaceholder: 'Name this lineup (e.g. Ultra + Codex)...',
        saveProfileButton: 'Save Lineup',
        savingProfile: 'Saving...',
        profileSaved: (name) => `Saved lineup "${name}".`,
        profileApplied: (name) => `Applied saved lineup "${name}".`,
        deleteProfileAria: (name) => `Delete saved lineup ${name}`,
        lastUsedBadge: 'Last Used',
        lastUsedNamedBadge: (name) => `Last Used: ${name}`,
        installedDone: 'Installed and rescanned.',
        folderSelected: 'Project folder updated.',
        gitEnabledDone: 'Version history turned on.',
        effortUnverified: 'Unverified',
        effortUnverifiedTitle: 'No tool or provider data confirms these levels; they are a safe default.',
        savedTeamCorrected: (changes) => `Some saved thinking-effort settings were not offered by their tool and were changed: ${changes}.`,
        apiKeysTitle: 'API Keys (Optional)',
        apiKeysSummary: (configured, total) => `${configured}/${total} configured`,
        apiKeysShow: 'Configure API Keys',
        apiKeysHide: 'Hide API Keys',
        apiKeysNote: 'Want to run models with an API key (Gemini, DeepSeek, OpenAI, Anthropic) instead of signing in to CLIs? Paste it here - stored locally on this computer only.',
        apiKeyPlaceholder: 'Paste API key...',
        apiKeySaving: 'Saving & rescanning...',
        apiKeySaved: 'API key updated and team rescanned.',
        apiKeyEnvSource: 'Environment',
        apiKeyMissing: 'Not set',
        needsApiKeyForTeam: (envKey) => `CLI installed - add ${envKey} in API Keys below to use it in your team.`,
        configureApiKeyAction: 'Set API Key',
        teamNeedsApiKeyNote: (names, keys) => `${names} detected locally - add ${keys} in API Keys above to include it in your team.`,
        syncModels: 'Check Latest Models',
        syncingModels: 'Checking models...',
        modelsSyncedDone: (added) => (added > 0 ? `Catalog synced (${added} new models added).` : 'Model catalog is up to date.'),
        modelsDailyHint: 'Auto-checks daily; retired models are removed automatically.',
        modelsSyncFailed: 'Could not refresh the model list right now. Showing the last saved list; it will retry every hour.',
        providerColumnLabel: 'Provider',
        modelColumnLabel: 'Model',
        effortColumnLabel: 'Thinking Effort',
        modelGroupLatest: 'Latest Recommended',
        modelGroupLegacy: 'More Models',
        effortUnsupported: 'This tool does not let you adjust thinking effort.',
      },
      brainstorm: {
        openTitle: 'Tell me in one sentence what you want to make',
        openHint: 'No need to have it all worked out. I will ask one short question at a time.',
        examplesTitle: 'Or start from an example:',
        moreExamples: 'More ideas',
        inputPlaceholder: 'For example: add a button that exports the order list to a spreadsheet',
        inputHint: 'Enter to send, Shift+Enter for a new line',
        send: 'Send',
        notSure: "I'm not sure, you decide",
        typewriter: 'Typing effect',
        restart: 'Start over',
        waitUnderstanding: 'Reading your idea...',
        waitDrafting: 'Updating the blueprint, this usually takes 10-40 seconds...',
        waitSlow: 'Taking longer than usual, still working on it...',
        blueprintTitle: 'Blueprint',
        emptyCard: 'Your blueprint lights up here, item by item, as we talk.',
        progress: (clear, total) => `Clear: ${clear}/${total}`,
        progressAssumed: (count) => `, ${count} picked by the AI for you`,
        items: {
          what: 'What to make',
          who: 'Who it is for',
          scope: 'How far this round goes',
          limits: 'What must not change',
          done: 'How we know it is done',
        },
        statuses: { clear: 'Clear', assumed: 'Picked by the AI for you', open: 'Not discussed yet' },
        editItem: 'Change',
        editPrefill: (item) => `About "${item}", I want to change it to: `,
        assumptionsTitle: 'Before you start: the AI picked these for you. Change any that are wrong.',
        notReadyMissing: (items) => `Still to talk about: ${items}.`,
        notReadyCheck: 'One thing is missing: a way to check the work is done, such as a test command. Tell the AI how you would check it, or let it pick one.',
        notReadyLineup: 'Connect an AI tool in Workspace before starting.',
        offlineNotice: 'No AI tool answered, so this blueprint was put together from your own words. Connect a tool in Workspace for a smarter partner.',
        liveFailed: (reason) => `The AI did not answer this time, so this draft was put together from your own words. Reason: ${reason}`,
        retry: 'Try again',
        confirmLaunch: 'Confirm Blueprint & Start Building',
        launching: 'Starting the build...',
        showRfc: 'Show technical document',
        hideRfc: 'Hide technical document',
      },
      pasteRfc: {
        title: 'Already have a written plan (an RFC)? Paste it here',
        hint: 'Paste or type the whole document, or drop a .md or .txt file onto the box. It is checked as you go; no chat needed.',
        switchToPaste: 'Paste an RFC instead',
        switchToChat: 'Describe it in a chat instead',
        previewTitle: 'Preview',
        previewEmpty: 'Your document shows here as you paste or type it.',
        recommending: 'Working out the team for this document...',
        recommendFailed: 'Could not work out the team for this document.',
        retry: 'Try again',
        dropTooLarge: 'This file is too large. Drop a text file under 256 KB.',
        dropNotText: 'Only text files (.md or .txt) can be dropped here.',
      },
      nodeDetail: {
        title: 'Task Details',
        summary: 'What happened',
        model: 'Model',
        elapsed: 'Time spent',
        cost: 'Cost',
        tests: 'Tests',
        changedFiles: 'Changed files',
        verdict: 'Reviewer verdict',
        close: 'Close',
        statuses: {
          PENDING: 'PENDING',
          RUNNING: 'RUNNING',
          GATE_CHECKING: 'GATE CHECKING',
          REVIEWING: 'REVIEWING',
          COOLDOWN: 'COOLDOWN',
          WAITING_HUMAN: 'WAITING HUMAN',
          PASSED: 'PASSED',
          FAILED: 'FAILED',
          SKIPPED: 'SKIPPED',
        },
        testStatuses: {
          passed: 'passed',
          failed: 'failed',
          not_run: 'not run',
          not_configured: 'not configured',
        },
        verdicts: {
          PASS: 'PASS',
          MINOR_FIX: 'MINOR FIX',
          MAJOR_REWORK: 'MAJOR REWORK',
          PLAN_AMENDMENT: 'PLAN AMENDMENT',
        },
      },
      decision: {
        title: 'Your Decision Is Needed',
        intro: 'The AI team paused here and needs your call. Read the question, pick an option, then submit.',
        submit: 'Submit Decision',
        submitting: 'Submitting…',
        noteLabel: 'Note for the team (optional)',
      },
      signOff: {
        title: 'Final Sign-Off',
        testsPassed: 'All verification checks passed',
        testsSummary: (passed, total) => `${passed}/${total} verification checks passed`,
        changedFiles: 'Changed files',
        battleReport: 'Open Battle Report',
        approve: 'Approve & Merge',
        revise: 'Request Changes',
        reviseNote: 'Tell the team what to change (required)',
        rollback: 'Roll Back',
        working: 'Processing…',
        rollbackHint: 'Available after approval while no newer commits land on your main branch.',
        rollbackConfirm: 'Roll back this merge? Your main branch returns to where it was before approval. Click Roll Back again to confirm, or press Esc to cancel.',
        done: 'Merged into your main branch. You can roll back while no newer commits land on it; the backup tag from run start stays as a recovery point.',
        revisedDone: 'Sent back with your notes. The run is paused until you resume it.',
        rolledBackDone: 'Rolled back. Your main branch is back where it was before approval.',
        kpiTests: 'Checks Passed',
        kpiFiles: 'Changed Files',
        kpiCost: 'Total Spend',
        kpiCostUnavailable: 'Not billed',
        workspaceLocation: 'Output Folder',
        openFolder: 'Open Folder',
        openFile: 'Open',
        revealFile: 'Locate',
        openFailed: 'Could not open this path locally.',
        deliverablesTitle: 'What Was Built',
        deliverablesEmpty: 'No task deliverables reported yet.',
        battleReportInline: 'Battle Report',
        battleReportToggleShow: 'Expand Report',
        battleReportToggleHide: 'Collapse Report',
        battleReportLoading: 'Loading battle report...',
        battleReportFailed: 'Could not load inline battle report.',
        copyReport: 'Copy Report',
        copiedReport: 'Copied',
      },
      errors: {
        dirtyWorkingTree: 'Some files have unsaved changes (dirty working tree). Commit or stash them, then try again.',
        notReadyForFinalGate: 'This run is not waiting for final sign-off anymore. Refresh to see its latest status.',
        rollbackRequiresCompleted: 'Rollback is available only right after a merge approval.',
        rollbackMovedPastMerge: 'Your main branch already has newer commits after this merge, so automatic rollback stopped safely.',
        emptyReviseNote: 'Please write a short note telling the team what to change.',
        requestTimedOut: 'The request got no answer in time.',
      },
    },
    glossary: {
      open: 'Glossary',
      title: 'Glossary',
      all: 'All',
      close: 'Close',
      search: 'Search terms…',
      plain: 'In plain words',
      pro: 'Technical detail',
      related: 'Related terms',
      empty: 'No matching terms.',
    },
  },
  zh: {
    docTitle: 'VibeBaton — 多智能体工作流画布',
    header: {
      localConnected: '已连接本地',
      standaloneDemo: '独立演示模式',
      languageAria: '界面语言',
      guideButton: '教程',
      switchToLight: '切换到浅色模式',
      switchToDark: '切换到深色模式',
      soundButtonAria: '液体切换音效设置',
      soundTitle: '液体同步音效',
      soundToggleLabel: '开启音效',
      soundVolumeLabel: '音量',
      soundPreview: '试听',
      soundOn: '已开启',
      soundOff: '默认关闭',
      modeLive: '实时运行',
      modeReplay: '案例回放',
      studioModeAria: '工作台模式',
    },
    tabs: {
      ariaLabel: '工作区视图',
      canvas: '画布',
      sidebar: '侧边栏',
      inspector: '属性检查',
    },
    splitPane: {
      sidebarHandleLabel: '调整侧边栏宽度',
      inspectorHandleLabel: '调整属性检查面板宽度',
      resizeHint: '双击恢复面板默认宽度。',
    },
    sidebar: {
      presetsTitle: '预置工作流',
      nodePaletteTitle: '节点面板',
      importExportTitle: '导入与导出',
      importButton: '导入 .baton.json',
      exportButton: '导出 JSON',
      shareButton: '分享链接',
      validationTitle: '图校验',
      notValidated: '未校验',
      valid: '校验通过',
      validWithWarnings: (count) => `通过 · ${count} 条警告`,
      invalidWithErrors: (count) => `无效 · ${count} 条错误`,
      presetCounts: (nodes, edges) => `${nodes} 节点 · ${edges} 连线`,
      difficulty: {
        beginner: '入门',
        intermediate: '进阶',
        pro: '专业',
        expert: '专家',
        live: '实时',
      },
      roleMustBeString: (index) => `第 ${index} 个节点的角色字段必须为字符串`,
      liveRunTitle: '实时运行工作流',
      liveRunHint: '点击查看真实里程碑与任务 DAG',
      liveRunTasks: (passed, total) => `${passed}/${total} 个任务`,
      liveRunActiveBadge: '实时同步',
    },
    transfer: {
      sectionTitle: '工作流配方与案例分享',
      sectionSubtitle: '配方（.baton.json）保存工作流，运行案例（.baton-case.json）用于回放运行记录。',
      recipeBadge: '配方',
      caseBadge: '运行案例',
      importCard: {
        title: '导入配方或案例',
        desc: '选择文件、粘贴 JSON 或配方链接。',
      },
      exportRecipeCard: {
        title: '导出配方',
        desc: '保存或分享当前工作流。',
      },
      exportCaseCard: {
        title: '导出运行案例',
        desc: '生成已脱敏的运行回放。',
      },
      importModal: {
        title: '导入配方或案例',
        dropHint: '将 .baton.json 或 .baton-case.json 文件拖到此处，或点击选择文件。',
        pasteLabel: '粘贴 JSON 或配方链接',
        detectRecipe: '已识别配方',
        detectCase: '已识别运行案例',
        invalid: '请输入有效的配方、案例或配方链接。',
        nodes: '节点',
        edges: '连线',
        duration: '耗时',
        tasks: '任务',
        validationOk: '校验通过',
        validationFail: '校验失败',
        redactionClean: '脱敏检查通过',
        redactionWarn: '请检查脱敏结果',
        applyRecipe: '将配方应用到画布',
        loadCase: '加载并回放案例',
        overwriteWarning: '继续操作将替换当前画布。',
      },
      exportRecipeModal: {
        title: '导出配方',
        assurance: '配方保存工作流结构和模型路由。',
        liveAdvisory: '如需分享本次运行的回放，请导出运行案例。',
        switchToCase: '导出运行案例',
        download: '下载 .baton.json',
        copyJson: '复制 JSON',
        copyLink: '复制配方链接',
        copied: '已复制到剪贴板',
        previewToggle: '预览 JSON',
        counts: (nodes, edges) => `${nodes} 个节点 · ${edges} 条连线`,
        manualCopyHint: '请手动复制下方内容。',
      },
      exportCaseModal: {
        title: '导出运行案例',
        titleLabel: '案例标题',
        includeReviews: '包含已脱敏的审校摘要',
        anonymize: '匿名化运行 ID',
        checklistTitle: '脱敏检查清单',
        secrets: '已遮蔽密钥',
        paths: '已匿名化路径',
        emails: '已遮蔽邮箱地址',
        ips: '已遮蔽内网 IP 地址',
        diffs: '已移除原始代码差异',
        stacks: '已移除堆栈追踪',
        verifiedClean: '脱敏检查通过',
        notClean: '分享前请检查脱敏结果',
        download: '下载 .baton-case.json',
        copyJson: '复制案例 JSON',
        copied: '已复制',
        defaultTitle: '运行回放',
        previewReplay: '在播放器中预览',
        loading: '正在生成运行案例…',
        error: '生成运行案例失败。',
      },
      playback: {
        tutorialTooltip: '用一期示范练习回放操作。选择「导入配方或案例」即可打开共享的 .baton-case.json 文件。',
        startPrefix: '开始回放：',
        switcherLabel: '选择回放案例',
        importAnother: '导入其他案例',
        resetTutorial: '返回一期示范教程',
        summaryPill: (elapsed, passed, total, { separator = ' · ', clean = true } = {}) =>
          [elapsed, `${passed}/${total} 项任务`, clean ? '脱敏回放' : '请检查脱敏结果'].join(separator),
      },
      liveRun: { shareCase: '分享案例' },
    },
    nodeTypes: {
      planner_node: '规划',
      router_node: '路由',
      worker_node: '执行',
      gate_node: '门禁',
      reviewer_node: '审校',
      merge_node: '合入',
      human_gate_node: '人工终审',
    },
    nodeStates: {
      active: '● 运行中',
      retrying: '↻ 重试中',
      escalated: '▲ 已升级',
      passed: '✓ 通过',
      failed: '✕ 失败',
    },
    nodeCard: {
      parallelWorkersTitle: '并发执行数',
    },
    liveClock: {
      live: '实时计时',
      liveBadgeLabel: '计时进行中',
    },
    attention: {
      humanAttentionRequired: '需要人工处理',
      waitingHuman: '等待人工裁决',
      readyForFinalGate: '待终审合入',
      failed: '运行失败',
      paused: '运行已暂停',
      longCooldown: '供应方配额冷却中',
      approve: '批准',
      reject: '拒绝',
      resume: '恢复运行',
      viewBattleReport: '查看战报',
      enableDesktopAlerts: '启用桌面提醒',
      notificationsEnabled: '桌面提醒已启用',
      notificationsBlocked: '桌面提醒已被阻止',
      dismiss: '关闭提醒',
      rejectNotePlaceholder: '填写拒绝理由',
      fallbackDetails: {
        waiting_human: '运行正在等待人工裁决。',
        ready_for_final_gate: '全部里程碑已通过，等待终审。',
        failed: '运行因错误而停止。',
        paused: '运行当前处于暂停状态。',
        long_cooldown: '任务正在等待供应方配额恢复。',
      },
      docTitlePrefix: '[⚠ 提醒 ',
      badges: {
        waiting_human: '人工裁决',
        ready_for_final_gate: '终审',
        failed: '失败',
        paused: '暂停',
        long_cooldown: '配额冷却',
      },
    },
    playback: {
      scenarioAria: '仿真场景',
      scenarios: {
        happy_path: '正常流转',
        gate_retry: '门禁重试',
        escalate: '熔断升级',
      },
      replayButton: '示范教程：一期真跑',
      replayTitle: '回放真实一期自举记录（run-20261121-044454-3b1845 · 107 分钟 @ 60×）',
      exitReplay: '退出回放',
      backToBlueprint: '返回工作流蓝图',
      liveBanner: (runId) => `实时同步 · ${runId}`,
      play: '播放',
      pause: '暂停',
      stepBack: '单步后退',
      stepForward: '单步前进',
      reset: '重置回放',
      speedAria: (speed) => `回放倍速 ${speed}x`,
      stepCount: (step, total) => `步骤 ${step} / ${total}`,
      ready: '就绪',
      traceKinds: {
        node_started: '节点启动',
        node_completed: '节点完成',
        node_failed: '节点失败',
        edge_traversed: '连线流转',
        loop_limit_reached: '达到循环上限',
        graph_completed: '流程完成',
        graph_halted: '流程中止',
      },
    },
    inspector: {
      asideAria: '工作流属性面板',
      tablistAria: '属性检查视图',
      tabInspector: '属性检查',
      tabTrace: '轨迹与实时运行',
      detailsId: '编号',
      detailsName: '名称',
      detailsDifficulty: '难度',
      detailsDescription: '说明',
      detailsNodes: '节点数',
      detailsEdges: '连线数',
      emptyHint: '点击画布上的任意节点或连线，即可查看属性或热切换模型。',
      openTraceLive: '查看轨迹与实时运行',
      nodeHeadingPrefix: '节点',
      edgeHeadingPrefix: '连线',
      fields: {
        label: '名称',
        role: '角色',
        provider: '供应方',
        model: '模型',
        maxLoops: '最大循环',
        sourceHandle: '源端口',
        targetHandle: '目标端口',
      },
      saveHotReload: '保存到 baton.toml（热重载）',
      canvasImmediateNote: '字段修改会立即更新画布配方；保存则将全局角色默认配置写入 baton.toml。',
      demoHotSwapHintPrefix: '本地运行 ',
      demoHotSwapHintSuffix: ' 即可实时热切换模型',
      traceTitle: '执行轨迹',
      traceAria: '仿真轨迹',
      noTrace: '暂无轨迹数据。',
      liveSectionAria: '实时运行',
      liveTitle: '实时运行',
      reconnecting: '重连中…',
      runSyncing: '正在加载选中运行…',
      runSyncFailed: '选中运行加载失败，请刷新或切换其他运行。',
      runHistoryLabel: '历史运行切换',
      runHistoryOption: (id, status, passed, total, elapsed) => `${id} · ${status}（${passed}/${total} 任务 · ${elapsed}）`,
      stageTimingTitle: '阶段耗时明细',
      modelRuntimeTitle: '模型运行统计',
      billingTitle: 'Token 用量与费用',
      billingTotalCost: (usd) => `总费用 ${usd}`,
      billingTokens: (prompt, completion, cached) => `输入 ${prompt} · 输出 ${completion} · 缓存 ${cached}`,
      billingPerModel: (prompt, completion) => `输入 ${prompt} · 输出 ${completion}`,
      billingExactBadge: '精确计费',
      totalElapsed: (elapsed) => `总耗时：${elapsed}`,
      estimatedTag: '推算',
      callCount: (count) => `${count} 次调用`,
      avgDuration: (avg) => `均耗 ${avg}`,
      taskDetailHint: '点击任意任务行可展开门禁、白名单与审校事件详情',
      taskDetailTitle: '任务审计详情',
      taskDetailModel: '分配模型',
      taskDetailDuration: '耗时',
      taskDetailCounters: (heal, reject, escalated) => `自愈 ${heal} 次 · 退修 ${reject} 次 · 升级 ${escalated} 次`,
      taskDetailFiles: '允许修改白名单',
      taskDetailLastError: '最近门禁 / 异常记录',
      taskDetailEvents: '该任务审计事件',
      taskDetailNoEvents: '暂无该任务的专项审计事件。',
      startRealRun: '去引导模式开始运行',
      battleReport: '战报',
      pauseRun: '暂停',
      resumeRun: '恢复',
      decisionNote: '审批备注（可选）',
      approve: '批准',
      reject: '驳回',
      tasksAria: '任务列表',
      table: {
        id: '编号',
        title: '标题',
        tier: '层级',
        status: '状态',
        assignee: '执行角色',
      },
      noTasks: '暂无任务。',
      noRuns: '暂无运行记录。',
      runStatuses: {
        PLANNING: '规划中',
        IN_PROGRESS: '进行中',
        REVIEWING: '审校中',
        GATE_CHECKING: '门禁检查中',
        COOLDOWN: '配额冷却中',
        RUNNING: '运行中',
        PAUSED: '已暂停',
        WAITING_HUMAN: '等待人工审批',
        READY_FOR_FINAL_GATE: '待终审合入',
        COMPLETED: '已完成',
        FAILED: '已失败',
        HALTED: '已中止',
        PASSED: '已通过',
        PENDING: '排队中',
        REJECTED: '已驳回',
        CANCELLED: '已取消',
        ESCALATED: '已升级',
        UNKNOWN: '未知状态',
      },
      eventLogTitle: '事件日志',
      eventLogAria: '运行事件日志',
      mergeConflictEventKinds: {
        merge_conflict_detected: '检测到合并冲突',
        merge_conflict_resolved: '合并冲突已解决',
        merge_conflict_failed: '合并冲突解决失败',
      },
      noEvents: '暂无事件。',
      originalNote: '查看原文',
      planningStageLabel: '01_PLAN · 规划',
      panelStageLabel: '专家会诊',
      liveGraphNodes: {
        specialist: '会诊专家',
        synthesizer: '综合裁决',
      },
      modalReportTitle: '战报详情',
      reportRendered: '渲染视图',
      reportRaw: '原始 Markdown',
      reportCopy: '复制 Markdown',
      copiedInline: '已复制',
      rfcSourceLegend: 'RFC 来源',
      rfcMarkdownOption: 'RFC Markdown 文本',
      rfcRepoPathOption: '仓库路径',
      rfcMarkdownAria: 'RFC Markdown 内容',
      rfcRepoPathAria: '仓库相对路径',
      runModeLabel: '运行模式',
      runModes: {
        overnight: '通宵无人值守',
        interactive: '交互式',
      },
      cancel: '取消',
      startRun: '立即启动',
      errors: {
        enterRelativePath: '请输入相对于仓库根目录的路径。',
      },
      modalCloseAria: '关闭弹窗',
    },
    toasts: {
      imported: (name) => `已导入工作流：${name}`,
      loadedShared: (name) => `已加载分享工作流：${name}`,
      invalidShared: (reason) => `无效的分享链接：${reason}`,
      shareCopied: '已复制分享链接到剪贴板',
      shareUpdatedBar: '已将分享链接更新至地址栏',
      replayLoaded: '已加载一期真实自举回放（v0.2.0 · 107 分钟 @ 60×）',
      unknownPreset: (id) => `未知预置工作流 '${id}'`,
      savedRole: (role, model) => `已保存 ${role} → ${model}（热重载生效）`,
      reportCopied: '已复制战报 Markdown 到剪贴板',
    },
    quickStart: {
      title: '快速开始与新手教程',
      subtitle: '像接力赛一样编排多个 AI 模型协同编码 —— 点击下方任意引导卡片即可直接上手。',
      tablistAria: '教程分页',
      tabQuickStart: '快速开始',
      tabLegend: '图例与快捷键',
      tabTutorial: '详细教程',
      steps: {
        tryStarterTitle: '1. 运行「极简入门双层流」演示',
        tryStarterDesc: '加载低成本 DSH 双层工作流，并播放正常流转接力动画。',
        watchReplayTitle: '2. 观看一期自举 60× 真实回放',
        watchReplayDesc: '重温 VibeBaton 在 3 个里程碑中的真实自举轨迹、门禁拦截与熔断升级过程。',
        inspectNodeTitle: '3. 编辑节点配置与模型热切换',
        inspectNodeDesc: '选中画布上的执行节点，可在右侧修改模型或通过 #recipe 链接分享整套工作流。',
      },
      tutorialChapters: [
        {
          title: '1. 一分钟看懂 VibeBaton（大模型接力工厂）',
          summary: '把开发拆成流水线接力赛：规划、编码、测试、审校各司其职，只在关键节点花高阶模型额度。',
          points: [
            'L0（你 + 总控大脑）：开工前头脑风暴对齐需求与验收命令，全部完成通过后再看战报签字合并主分支。',
            'L1（规划师 & 里程碑审校）：把需求拆成带依赖关系的里程碑和任务，并在每个里程碑合入前把关整体验收。',
            'L3（DSH 并发工人）：在独立 Git Worktree 沙盒目录里高并发开发常规模块，改错不会污染主工作区。',
            '机械门禁 + L2 审校：先免费跑本地测试和静态检查抓低级错误，全过后再请高阶审校官把关，省钱又稳。',
          ],
        },
        {
          title: '2. 五步跑通首次真实任务',
          summary: '无需记忆复杂命令，跟随侧边栏和引导模式五步就能启动一个安全的通宵或交互任务。',
          points: [
            '第 1 步（选预算与绿色预设）：左侧选择「节省 / 均衡 / 质量优先」预算档位，挑一个显示绿色「本机就绪」的工作流。',
            '第 2 步（点「去引导模式开始运行」）：引导模式先核对工作区和本机工具是否就绪，然后用对话说清需求，或者直接粘贴写好的 RFC。',
            '第 3 步（核对团队、流程和预算）：发车卡会列出文档、每个角色用的工具和型号、本次流程和项目预算，核对无误后再确认启动。',
            '第 4 步（画布实时同步看板）：发车或已有运行后，点击左上角「实时运行工作流」卡片，中间画布会实时亮起每个里程碑和任务节点。',
            '第 5 步（查看战报与 L0 终审合入）：任务收官后可点开中文战报、阶段耗时、模型耗时与单任务审计详情，确认无误后再合并主分支。',
          ],
        },
        {
          title: '3. 新手常见问题排查（FAQ）',
          summary: '遇到困惑先看这里，覆盖 90% 的初上手疑问。',
          points: [
            '问：为什么运行中左侧和中间画布没有自动显示真实任务？答：预设栏显示的是工作流蓝图，请点击左上角「实时运行工作流」卡片切换到真实任务 DAG 画布。',
            '问：怎么配置最省钱？答：新手建议选择「极简入门双层流」或「DSH 批量工厂」，并将预算档位切到「节省」。',
            '问：半夜触发 429 限流或模型卡死怎么办？答：系统只把限流供应方送入冷却池，其他工具照常工作；同一任务多次不过会自动阶梯升档到更强模型。',
            '问：AI 会不会把我的 main 主分支改乱？答：不会。所有改动都只在隔离工作树与 dev 分支内运行，且受文件白名单物理限制，最后必须由你 L0 确认才合入主干。',
          ],
        },
      ],
      legendTiersTitle: '层级配色与职责说明',
      legendTiers: [
        { key: 'L0', name: 'L0 · 头脑风暴与终审', desc: '在开工前对齐规格需求，并在最终合并前由用户签字把关。' },
        { key: 'L1', name: 'L1 · 规划与里程碑评审', desc: '将主规格拆解为无环任务图，并在里程碑合入前把关质量。' },
        { key: 'L2', name: 'L2 · 核心攻坚与微观审校', desc: '负责核心架构编写、熔断升级接管以及常规任务的逐项审校。' },
        { key: 'L3', name: 'L3 · 并发批量执行', desc: '通过 DSH 高并发完成大量常规模块与单元测试开发。' },
        { key: 'GATE', name: '机械测试门禁', desc: '先运行本地单测与静态检查拦截低级缺陷，节省上层审校额度。' },
        { key: 'MERGE', name: '里程碑分支合入', desc: '自动校验文件改动白名单并执行工作树压缩合并。' },
      ],
      legendEdgesTitle: '语义流转边颜色说明',
      legendEdges: [
        { tone: 'normal', name: '正常推进 / 校验通过', desc: '青蓝脉冲与翠绿实线代表正常任务接力与门禁/审校通过。' },
        { tone: 'retry', name: '本地自愈 / 退回修改', desc: '琥珀金回环在 max_loops 次数限制内驱动自动修 bug 与复检。' },
        { tone: 'escalate', name: '熔断升级专家接管', desc: '品红色升级边在低成本节点连续阻塞时自动转交专家级模型。' },
      ],
      shortcutsTitle: '常用快捷键',
      shortcuts: [
        { keys: 'Space', desc: '播放或暂停当前工作流动画回放' },
        { keys: '← / →', desc: '单步后退或前进一帧轨迹事件' },
        { keys: 'Delete / Backspace', desc: '删除当前选中的节点或连线' },
      ],
      dontShowAgain: '下次打开不再自动弹出',
      getStarted: '开始使用',
    },
    tour: {
      startTourButton: '开始 1 分钟交互式导览',
      startTourBanner: '跟随高亮提示，熟悉工作台的主要操作。',
      stepProgress: (current, total) => `第 ${current} 步，共 ${total} 步`,
      next: '下一步',
      prev: '上一步',
      skip: '跳过',
      finish: '完成',
      clickHint: '点击高亮区域继续。',
      steps: {
        'live-run-card': {
          title: '实时运行工作流',
          description: '在画布上跟踪选中运行的里程碑进度。',
          hint: '点击实时运行卡片打开对应的工作流。',
        },
        'budget-profile': {
          title: '预算档位',
          description: '为本地运行设置成本和推理强度偏好。',
          hint: '查看节省、均衡和质量优先三个档位。',
        },
        'recipe-plaza': {
          title: '工作流广场',
          description: '按项目类型或本机就绪状态筛选工作流预设。',
          hint: '选择一个预设，将它加载到画布。',
        },
        'canvas-workspace': {
          title: '画布与回放',
          description: '查看工作流图、播放模拟轨迹或跟踪实时运行。',
          hint: '选中一个节点，或试用回放控件。',
        },
        'demo-playback': {
          title: '第一阶段回放',
          description: '在离线演示中观看四层工作流的运行记录。',
          hint: '点击「回放」加载运行记录，然后逐步查看事件。',
        },
        'inspector-live-tab': {
          title: '轨迹与实时运行',
          description: '查看模拟事件，并在本地模式下监控真实运行。',
          hint: '打开高亮标签页查看轨迹。',
        },
        'start-real-run-btn': {
          title: '开始运行',
          description: '运行都从引导模式开始，开工前会列出团队、流程和预算让你确认。',
          hint: '点击这个按钮前往引导模式。',
        },
        'header-controls': {
          title: '工作台控件',
          description: '切换语言和主题、调整声音或重新打开教程。',
          hint: '点击「教程」可以回到指南。',
        },
      },
    },
    tutorialDiagrams: {
      relayCaption: '从任务规划到人工终审的四层协作流程。',
      relayAria: '用户确定目标，规划师拆分任务，DSH 执行节点实现需求，机械门禁和代码审校通过后由用户终审合并。',
      guidedFlowCaption: '从选择预算和工作流到查看战报。',
      guidedFlowAria: '选择预算和工作流，在引导模式里核对团队和流程后发车，在画布上跟踪实时运行，最后查看双语战报并签字。',
      sandboxCaption: '并行工作树与路径白名单保护主分支。',
      sandboxAria: '执行节点在隔离的 Git 工作树中修改代码，路径白名单回退越界改动，合入主分支前须通过人工终审。',
      l0User: 'L0 用户',
      l1Planner: 'L1 规划师',
      l3Workers: 'L3 DSH 批量执行',
      mechanicalGate: '机械门禁',
      l2Reviewer: 'L2 审校',
      finalMerge: 'L0 终审合并',
      budgetRecipe: '预算与工作流',
      wizardGuards: '引导发车与确认',
      liveSync: '实时运行与画布同步',
      bilingualReport: '双语战报与 L0 签字',
      worktrees: '隔离的 Git 工作树',
      whitelistRevert: '路径白名单回退',
      mainBranch: '受保护的主分支',
    },
    recipePlaza: {
      title: '工作流广场',
      filters: {
        all: '全部',
        ready_on_host: '本机就绪',
        same_family: '同家族',
        bulk_batch: '批量处理',
        small_project: '小型项目',
        audit: '审计',
        panel: '会诊协作',
      },
      hostReady: '本机就绪',
      hostMissing: '本机未就绪',
      costTiers: { low: '低', medium: '中', high: '高' },
    },
    budgetProfile: {
      label: '预算档位',
      options: {
        eco: { label: '节省', tooltip: '优先选择成本较低的模型和推理档位。' },
        balanced: { label: '均衡', tooltip: '根据任务平衡成本与推理强度。' },
        max_quality: { label: '质量优先', tooltip: '优先选择能力更强的可用模型和更高的推理档位。' },
      },
    },
    pricing: {
      title: '模型单价',
      openButton: '模型单价',
      syncButton: '立即同步官方价',
      lastSynced: '最近同步',
      neverSynced: '尚未同步',
      autoSyncEvery24h: '每 24 小时自动同步',
      stale: '缓存已过期',
      syncing: '正在同步价格…',
      syncFailed: '官方价格同步失败',
      columns: {
        model: '模型',
        source: '来源',
        input: '输入',
        cached: '缓存输入',
        output: '输出',
        actions: '操作',
      },
      unit: '美元 / 百万 Token',
      sourceCustom: '自定义',
      sourceOfficialCache: '官方缓存',
      sourceBuiltin: '内置官方价',
      edit: '编辑',
      save: '保存',
      cancel: '取消',
      resetToOfficial: '恢复官方价',
      invalidNumber: '请输入有限的非负数。',
      saved: '单价已保存',
      saveFailed: '保存自定义单价失败',
      close: '关闭',
      searchLabel: '搜索模型',
      searchPlaceholder: '输入模型关键词筛选，例如 claude、gemini、gpt...',
      clearSearch: '清空',
      searchCount: (shown, total) => (shown === total ? `共 ${total} 个模型` : `匹配 ${shown} / ${total} 个`),
      noMatches: '没有匹配该关键词的模型。',
    },
    nodeReadiness: {
      statuses: { ready: '就绪', cooldown: '冷却中', missing: '缺失' },
      doctorButton: '5 秒诊断',
      doctorTimeout: '探测在 5 秒后超时。',
      latency: (milliseconds) => `延迟 ${milliseconds} 毫秒`,
      installHint: '配置提示',
      dshInstallHint: '请安装 DeepSeek Harness CLI 并配置 DSH 网关密钥。',
      pinModelOverride: '固定模型覆盖设置',
    },
    credentials: {
      title: '凭据设置',
      keyLabels: {
        GEMINI_API_KEY: 'Gemini API 密钥',
        DEEPSEEK_API_KEY: 'DeepSeek API 密钥（DSH）',
        OPENAI_API_KEY: 'OpenAI API 密钥',
        OPENCODE_API_KEY: 'DSH 网关密钥',
        ANTHROPIC_API_KEY: 'Anthropic API 密钥',
      },
      save: '保存',
      clear: '清除',
    },
    wizard: {
      fields: {
        goal: '目标',
        constraints: '约束',
      },
      readinessScore: (score) => `就绪评分 · ${score}/100`,
      warnings: {
        title: '警告',
        missingSections: '缺少的 RFC 章节',
        missingVerificationCommand: '添加验证命令以自动检查运行结果。',
        unsafeForOvernight: '请处理就绪检查发现的问题，再启动通宵运行。',
        ambiguityMarker: (marker) => `用具体要求替换含义不明确的标记「${marker}」。`,
        questionInHeading: '请将 RFC 标题中的问题改写为明确的要求。',
        shortGoal: '请将目标扩写至至少 40 个字符。',
        unnumberedAcceptance: '请为每条验收标准编号。',
      },
      runModes: { overnight: '通宵无人值守', interactive: '交互式' },
    },
    guided: {
      m3: GUIDED_M3_ZH,
      mode: { guided: '引导模式', pro: '专业模式' },
      workbench: {
        stepsAria: '引导步骤',
        waitingForRun: '正在启动施工，计划就绪后这里会显示任务地图……',
        nodeHint: '点击地图上的任意任务，用通俗的话查看发生了什么。',
        pausedBanner: '运行已暂停，你可以从暂停处继续运行，或重新制定一份蓝图。',
        resumeRun: '继续运行',
        newBlueprint: '重新制定蓝图',
        changeTeam: '切换工作区 / 工具',
        currentTeamPrefix: '当前团队：',
      },
      steps: [
        { title: '工作区', hint: '选择项目文件夹，并确认本机已有的 AI 编程工具。' },
        { title: '蓝图', hint: '说说你想做什么，与架构伙伴一起把方案打磨成形。' },
        { title: '施工', hint: '查看 AI 团队如何规划、编写、测试并评审每个任务。' },
        { title: '验收', hint: '检查成果，决定是否合入你的主分支。' },
      ],
      setup: {
        pickFolder: '选择项目文件夹',
        applyPath: '应用路径',
        currentFolder: '当前项目文件夹',
        browsing: '正在打开文件夹选择窗口……',
        switchingFolder: '正在切换项目文件夹并扫描工具……',
        initializingGit: '正在开启版本记录……',
        gitReady: '版本记录已开启，每一处改动都可审阅、可撤销。',
        gitMissing: '这个文件夹还没有开启版本记录。开启后，每一处改动都可以撤销。',
        initGit: '开启版本记录',
        firstCommitMissing: '这个项目还没有第一份存档，无法开始施工。点一下就能创建，你的文件不会被改动。',
        createFirstCommit: '创建第一份存档',
        creatingFirstCommit: '正在创建第一份存档……',
        firstCommitDone: '第一份存档已创建。',
        continueNeedsHistory: '请先在上方开启版本记录，施工需要它才能开始。',
        scanClis: '扫描 AI 编程工具',
        scanning: '正在扫描本机……',
        scanSummary: (ready, total) => `已就绪 ${ready}/${total}`,
        filterAll: '全部',
        filterReady: '已就绪',
        filterNeedsSetup: '待配置',
        install: '安装',
        installing: '正在安装……',
        installConsent: '允许 VibeBaton 执行以下安装命令：',
        login: '登录',
        openingLogin: '正在打开登录窗口……',
        needsLogin: '需要登录',
        ready: '已就绪',
        missing: '未安装',
        tiers: { official: '官方', community: '社区' },
        lineupReady: '你的 AI 团队已准备就绪。',
        lineupMissing: '请至少安装并登录一个 AI 编程工具来组建团队。',
        presetRecommended: '推荐搭配',
        presetAllProvider: (provider) => `全部使用 ${provider}`,
        customizeRoles: '自定义角色分工',
        hideCustomizeRoles: '收起角色分工',
        resetLineup: '恢复推荐搭配',
        customBadge: '已自定义',
        useLineup: '进入下一步：共创蓝图',
        useCustomLineup: '使用当前搭配，进入下一步',
        savedProfilesTitle: '已保存方案：',
        saveProfilePlaceholder: '给当前分工命名（如 Ultra主力 + Codex攻坚）...',
        saveProfileButton: '保存分工方案',
        savingProfile: '正在保存…',
        profileSaved: (name) => `已保存分工方案「${name}」。`,
        profileApplied: (name) => `已切换为「${name}」分工方案。`,
        deleteProfileAria: (name) => `删除分工方案 ${name}`,
        lastUsedBadge: '上次使用',
        lastUsedNamedBadge: (name) => `上次使用：${name}`,
        installedDone: '安装完成并已重新扫描。',
        folderSelected: '项目文件夹已切换。',
        gitEnabledDone: '版本记录已开启。',
        effortUnverified: '未经核实',
        effortUnverifiedTitle: '没有读到工具或服务方的数据，这几档是保守的默认值。',
        savedTeamCorrected: (changes) => `之前保存的团队里有工具不支持的思考强度，已自动改正：${changes}。`,
        apiKeysTitle: 'API 密钥（可选，使用 API 时在此配置）',
        apiKeysSummary: (configured, total) => `已配置 ${configured}/${total}`,
        apiKeysShow: '配置 API 密钥',
        apiKeysHide: '收起 API 密钥',
        apiKeysNote: '想直接用 API 密钥（如 Gemini、DeepSeek、OpenAI、Anthropic）而不用登录命令行工具？直接在这里粘贴保存即可，密钥仅存在本机，不会上传到代码仓库。',
        apiKeyPlaceholder: '粘贴 API 密钥……',
        apiKeySaving: '正在保存并重新扫描……',
        apiKeySaved: 'API 密钥已更新，已重新扫描团队。',
        apiKeyEnvSource: '环境变量',
        apiKeyMissing: '未设置',
        needsApiKeyForTeam: (envKey) => `已检测到 CLI，但在下方「API 密钥」填写 ${envKey} 后才能加入团队。`,
        configureApiKeyAction: '去填写 API 密钥',
        teamNeedsApiKeyNote: (names, keys) => `检测到本机已安装 ${names}，在上方「API 密钥」填写 ${keys} 后即可在团队中选用。`,
        syncModels: '检查最新模型',
        syncingModels: '正在检查更新……',
        modelsSyncedDone: (added) => (added > 0 ? `已检查模型库，新增 ${added} 个模型。` : '模型库已是最新。'),
        modelsDailyHint: '每天自动检查一次最新模型，已下架的模型会自动移除。',
        modelsSyncFailed: '暂时没能更新模型列表，先显示上次保存的版本，之后每小时会自动重试。',
        providerColumnLabel: '提供方',
        modelColumnLabel: '模型',
        effortColumnLabel: '思考强度',
        modelGroupLatest: '最新推荐模型',
        modelGroupLegacy: '更多可选模型',
        effortUnsupported: '这个工具不支持调整思考强度。',
      },
      brainstorm: {
        openTitle: '用一句话说说你想做什么',
        openHint: '不用一次想清楚，我会一次只问一个小问题。',
        examplesTitle: '或者从一个例子开始：',
        moreExamples: '更多灵感',
        inputPlaceholder: '例如：加一个按钮，把订单列表导出成表格',
        inputHint: 'Enter 发送，Shift+Enter 换行',
        send: '发送',
        notSure: '我不确定，你帮我定',
        typewriter: '打字效果',
        restart: '重新开始',
        waitUnderstanding: '正在理解你的想法……',
        waitDrafting: '正在整理蓝图，通常需要 10–40 秒……',
        waitSlow: '比平时久一些，还在努力整理……',
        blueprintTitle: '蓝图',
        emptyCard: '聊着聊着，蓝图会在这里一项项亮起来。',
        progress: (clear, total) => `已明确 ${clear}/${total}`,
        progressAssumed: (count) => `，AI 代你假设了 ${count} 项`,
        items: {
          what: '做什么',
          who: '给谁用',
          scope: '做到什么程度',
          limits: '不能动什么',
          done: '怎么算完成',
        },
        statuses: { clear: '已明确', assumed: 'AI 代你假设', open: '还没聊到' },
        editItem: '改一下',
        editPrefill: (item) => `关于「${item}」，我想改成：`,
        assumptionsTitle: '开工前请知悉：下面几项是 AI 代你定的，不合适可以先改一下。',
        notReadyMissing: (items) => `还有这些没聊到：${items}。`,
        notReadyCheck: '还差一个确认「做完了」的办法，比如一条测试命令。直接告诉 AI 你想怎么检查，或者让它帮你定。',
        notReadyLineup: '请先在「工作区」连接一个 AI 工具，再开工。',
        offlineNotice: '暂时没有 AI 工具回应，这份蓝图是根据你的原话整理的。在「工作区」连接工具后，伙伴会更聪明。',
        liveFailed: (reason) => `这次 AI 没有成功回应，下面是根据你的原话整理的草稿。原因：${reason}`,
        retry: '重试',
        confirmLaunch: '确认蓝图并开始施工',
        launching: '正在启动 AI 施工……',
        showRfc: '查看技术文档',
        hideRfc: '收起技术文档',
      },
      pasteRfc: {
        title: '已经写好方案（RFC）了？直接粘贴在这里',
        hint: '粘贴或直接输入完整文档，也可以把 .md 或 .txt 文件拖进框里。边输入边检查，不用对话。',
        switchToPaste: '改为粘贴 RFC',
        switchToChat: '改为对话描述',
        previewTitle: '预览',
        previewEmpty: '粘贴或输入后，文档会显示在这里。',
        recommending: '正在为这份文档安排团队……',
        recommendFailed: '没能为这份文档安排团队。',
        retry: '重试',
        dropTooLarge: '文件太大了，请拖入 256 KB 以内的文本文件。',
        dropNotText: '这里只能拖入文本文件（.md 或 .txt）。',
      },
      nodeDetail: {
        title: '任务详情',
        summary: '发生了什么',
        model: '模型',
        elapsed: '耗时',
        cost: '成本',
        tests: '测试',
        changedFiles: '改动的文件',
        verdict: '评审结论',
        close: '关闭',
        statuses: {
          PENDING: '待运行',
          RUNNING: '运行中',
          GATE_CHECKING: '门禁检查中',
          REVIEWING: '评审中',
          COOLDOWN: '限流冷却中',
          WAITING_HUMAN: '需要你的决定',
          PASSED: '已通过',
          FAILED: '失败',
          SKIPPED: '已跳过',
        },
        testStatuses: {
          passed: '已通过',
          failed: '未通过',
          not_run: '尚未运行',
          not_configured: '未配置测试命令',
        },
        verdicts: {
          PASS: '通过',
          MINOR_FIX: '建议小幅修改',
          MAJOR_REWORK: '需要返工',
          PLAN_AMENDMENT: '需要调整计划',
        },
      },
      decision: {
        title: '需要你来决定',
        intro: 'AI 团队在这个任务上暂停了，需要你拍板后才能继续。',
        submit: '提交决定',
        submitting: '正在提交……',
        noteLabel: '给团队的备注（可选）',
      },
      signOff: {
        title: '最终验收',
        testsPassed: '全部验证检查已通过',
        testsSummary: (passed, total) => `${passed}/${total} 项验证检查通过`,
        changedFiles: '改动的文件',
        battleReport: '打开战报',
        approve: '批准并合并',
        revise: '要求修改',
        reviseNote: '告诉团队需要改什么（必填）',
        rollback: '回滚',
        working: '正在处理……',
        rollbackHint: '批准并合并后可用；若主分支已有新提交则自动锁定。',
        rollbackConfirm: '确定回滚这次合并吗？主分支将恢复到批准之前的状态。再次点击「回滚」确认，按 Esc 取消。',
        done: '已合入你的主分支。在主分支出现新提交之前仍可回滚；本次运行开始时创建的备份标签会保留作为恢复点。',
        revisedDone: '已附意见退回，运行将暂停，直到你重新启动。',
        rolledBackDone: '已回滚，主分支已恢复到批准前的状态。',
        kpiTests: '通过检查',
        kpiFiles: '产物文件',
        kpiCost: '本次总花费',
        kpiCostUnavailable: '未计费',
        workspaceLocation: '产物目录',
        openFolder: '打开项目文件夹',
        openFile: '打开',
        revealFile: '定位目录',
        openFailed: '本地无法打开该路径，请确认文件是否仍存在。',
        deliverablesTitle: '最终交付成果',
        deliverablesEmpty: '暂未上报细分任务成果。',
        battleReportInline: '战报摘要',
        battleReportToggleShow: '展开战报',
        battleReportToggleHide: '收起战报',
        battleReportLoading: '正在加载战报……',
        battleReportFailed: '在线战报加载失败，可点击右上角「打开战报」查看。',
        copyReport: '复制战报',
        copiedReport: '已复制',
      },
      errors: {
        dirtyWorkingTree: '有文件改动尚未提交（dirty working tree）。请先提交或暂存，再重试。',
        notReadyForFinalGate: '当前运行已不在等待终审阶段，请刷新查看最新状态。',
        rollbackRequiresCompleted: '只有在刚批准并合并后才能执行回滚。',
        rollbackMovedPastMerge: '主分支在本次合并后已有新提交，为保护后续改动，系统已停止自动回滚。',
        emptyReviseNote: '请先填写需要团队修改的内容。',
        requestTimedOut: '请求超时，没有等到回应。',
      },
    },
    glossary: {
      open: '术语表',
      title: '术语表',
      all: '全部',
      close: '关闭',
      search: '搜索术语……',
      plain: '通俗解读',
      pro: '技术定义',
      related: '相关术语',
      empty: '没有匹配的术语。',
    },
  },
};
