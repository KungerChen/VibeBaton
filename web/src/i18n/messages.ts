import type { ExecutionState, NodeType, Scenario, TraceKind } from '../types/graph';

export type Locale = 'en' | 'zh';

export interface Messages {
  docTitle: string;
  header: {
    localConnected: string;
    standaloneDemo: string;
    languageAria: string;
    guideButton: string;
    switchToLight: string;
    switchToDark: string;
  };
  tabs: {
    ariaLabel: string;
    canvas: string;
    sidebar: string;
    inspector: string;
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
  };
  nodeTypes: Record<NodeType, string>;
  nodeStates: Partial<Record<ExecutionState, string>>;
  nodeCard: {
    parallelWorkersTitle: string;
  };
  playback: {
    scenarioAria: string;
    scenarios: Record<Scenario, string>;
    replayButton: string;
    replayTitle: string;
    play: string;
    pause: string;
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
    demoHotSwapHintPrefix: string;
    demoHotSwapHintSuffix: string;
    traceTitle: string;
    traceAria: string;
    noTrace: string;
    liveSectionAria: string;
    liveTitle: string;
    reconnecting: string;
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
    noEvents: string;
    originalNote: string;
    modalStartTitle: string;
    modalReportTitle: string;
    reportRendered: string;
    reportRaw: string;
    reportCopy: string;
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
    modelOverridesLabel: string;
    cancel: string;
    startRun: string;
    startingRun: string;
    errors: {
      enterRfcMarkdown: string;
      enterRelativePath: string;
      invalidOverridesJson: string;
      overridesMustMapStrings: string;
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
    runStarted(runId: string, pid: number): string;
    reportCopied: string;
  };
  quickStart: {
    title: string;
    subtitle: string;
    tablistAria: string;
    tabQuickStart: string;
    tabLegend: string;
    steps: {
      tryStarterTitle: string;
      tryStarterDesc: string;
      watchReplayTitle: string;
      watchReplayDesc: string;
      inspectNodeTitle: string;
      inspectNodeDesc: string;
    };
    legendTiersTitle: string;
    legendTiers: readonly { key: string; name: string; desc: string }[];
    legendEdgesTitle: string;
    legendEdges: readonly { tone: 'normal' | 'retry' | 'escalate'; name: string; desc: string }[];
    shortcutsTitle: string;
    shortcuts: readonly { keys: string; desc: string }[];
    dontShowAgain: string;
    getStarted: string;
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
    },
    tabs: {
      ariaLabel: 'Workspace views',
      canvas: 'Canvas',
      sidebar: 'Sidebar',
      inspector: 'Inspector',
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
      },
      roleMustBeString: (index) => `nodes[${index}].role must be a string`,
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
    playback: {
      scenarioAria: 'Scenario',
      scenarios: {
        happy_path: 'Happy Path',
        gate_retry: 'Gate Retry',
        escalate: 'Escalate',
      },
      replayButton: 'Stage 1 60×',
      replayTitle: 'Replay real Stage 1 self-hosting run (run-20261121-044454-3b1845 · 107m @ 60×)',
      play: 'Play',
      pause: 'Pause',
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
      demoHotSwapHintPrefix: 'Run ',
      demoHotSwapHintSuffix: ' locally to hot-swap models',
      traceTitle: 'Trace',
      traceAria: 'Simulation trace',
      noTrace: 'No trace yet.',
      liveSectionAria: 'Live run',
      liveTitle: 'Live Run',
      reconnecting: 'reconnecting…',
      startRealRun: '▶ Start Real Run',
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
        RUNNING: 'RUNNING',
        PAUSED: 'PAUSED',
        WAITING_HUMAN: 'WAITING_HUMAN',
        READY_FOR_FINAL_GATE: 'READY_FOR_FINAL_GATE',
        COMPLETED: 'COMPLETED',
        FAILED: 'FAILED',
        HALTED: 'HALTED',
        PASSED: 'PASSED',
        PENDING: 'PENDING',
        UNKNOWN: 'UNKNOWN',
      },
      eventLogTitle: 'Event Log',
      eventLogAria: 'Run event log',
      noEvents: 'No events yet.',
      originalNote: 'Original note',
      modalStartTitle: 'Start Real Run',
      modalReportTitle: 'Battle Report',
      reportRendered: 'Rendered',
      reportRaw: 'Raw Markdown',
      reportCopy: 'Copy Markdown',
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
      modelOverridesLabel: 'Model overrides JSON (optional)',
      cancel: 'Cancel',
      startRun: 'Start Run',
      startingRun: 'Starting…',
      errors: {
        enterRfcMarkdown: 'Enter RFC markdown.',
        enterRelativePath: 'Enter a path relative to the repository.',
        invalidOverridesJson: 'Enter valid JSON for model overrides.',
        overridesMustMapStrings: 'Model overrides must map role names to model strings.',
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
      runStarted: (runId, pid) => `Run ${runId} started (pid ${pid})`,
      reportCopied: 'Battle report copied to clipboard',
    },
    quickStart: {
      title: 'Quick Start & Tutorial',
      subtitle: 'Orchestrate multiple AI models like a relay race — click any step below to try it live.',
      tablistAria: 'Guide sections',
      tabQuickStart: 'Quick Start',
      tabLegend: 'Legend & Shortcuts',
      steps: {
        tryStarterTitle: '1. Run Starter 2-Tier Flow Demo',
        tryStarterDesc: 'Load the minimal DeepSeek API starter workflow and animate Happy Path playback.',
        watchReplayTitle: '2. Watch Stage 1 Real Run (60×)',
        watchReplayDesc: 'Replay how VibeBaton built itself across 3 milestones, catching bugs and auto-escalating.',
        inspectNodeTitle: '3. Inspect & Hot-Swap Models',
        inspectNodeDesc: 'Select a worker card on the canvas to edit its provider/model or share via #recipe link.',
      },
      legendTiersTitle: 'Tier Colors & Roles',
      legendTiers: [
        { key: 'L0', name: 'L0 · Brainstorm & Sign-Off', desc: 'Interactive specification alignment and final human gate.' },
        { key: 'L1', name: 'L1 · Planner & Milestone Gate', desc: 'Decomposes RFC into a milestone DAG and audits final delivery.' },
        { key: 'L2', name: 'L2 · Critical & Micro Review', desc: 'Handles core architecture tasks, escalations, and per-task code review.' },
        { key: 'L3', name: 'L3 · Parallel Bulk Workers', desc: 'Runs high-concurrency routine implementation tasks via DeepSeek API.' },
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
        { keys: '→', desc: 'Advance playback one step forward' },
        { keys: 'Delete / Backspace', desc: 'Remove selected canvas node or edge' },
      ],
      dontShowAgain: "Don't show automatically on startup",
      getStarted: 'Get Started',
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
    },
    tabs: {
      ariaLabel: '工作区视图',
      canvas: '画布',
      sidebar: '侧边栏',
      inspector: '属性检查',
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
      },
      roleMustBeString: (index) => `第 ${index} 个节点的角色字段必须为字符串`,
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
    playback: {
      scenarioAria: '仿真场景',
      scenarios: {
        happy_path: '正常流转',
        gate_retry: '门禁重试',
        escalate: '熔断升级',
      },
      replayButton: '一期真跑 60×',
      replayTitle: '回放真实一期自举记录（run-20261121-044454-3b1845 · 107 分钟 @ 60×）',
      play: '播放',
      pause: '暂停',
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
      demoHotSwapHintPrefix: '本地运行 ',
      demoHotSwapHintSuffix: ' 即可实时热切换模型',
      traceTitle: '执行轨迹',
      traceAria: '仿真轨迹',
      noTrace: '暂无轨迹数据。',
      liveSectionAria: '实时运行',
      liveTitle: '实时运行',
      reconnecting: '重连中…',
      startRealRun: '▶ 启动真实运行',
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
        RUNNING: '运行中',
        PAUSED: '已暂停',
        WAITING_HUMAN: '等待人工审批',
        READY_FOR_FINAL_GATE: '待终审合入',
        COMPLETED: '已完成',
        FAILED: '已失败',
        HALTED: '已中止',
        PASSED: '已通过',
        PENDING: '排队中',
        UNKNOWN: '未知状态',
      },
      eventLogTitle: '事件日志',
      eventLogAria: '运行事件日志',
      noEvents: '暂无事件。',
      originalNote: '查看原文',
      modalStartTitle: '启动真实运行',
      modalReportTitle: '战报详情',
      reportRendered: '渲染视图',
      reportRaw: '原始 Markdown',
      reportCopy: '复制 Markdown',
      rfcSourceLegend: 'RFC 来源',
      rfcMarkdownOption: 'RFC Markdown',
      rfcRepoPathOption: '仓库路径',
      rfcMarkdownAria: 'RFC Markdown 内容',
      rfcRepoPathAria: '仓库相对路径',
      runModeLabel: '运行模式',
      runModes: {
        overnight: '通宵无人值守',
        interactive: '交互式',
      },
      modelOverridesLabel: '模型覆盖 JSON（可选）',
      cancel: '取消',
      startRun: '立即启动',
      startingRun: '启动中…',
      errors: {
        enterRfcMarkdown: '请输入 RFC Markdown 内容。',
        enterRelativePath: '请输入相对于仓库根目录的路径。',
        invalidOverridesJson: '请输入有效的 JSON 模型覆盖配置。',
        overridesMustMapStrings: '模型覆盖配置必须为“角色名: 模型名”的字符串映射。',
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
      runStarted: (runId, pid) => `运行 ${runId} 已启动（进程 ${pid}）`,
      reportCopied: '已复制战报 Markdown 到剪贴板',
    },
    quickStart: {
      title: '快速开始与新手教程',
      subtitle: '像接力赛一样编排多个 AI 模型协同编码 —— 点击下方任意引导卡片即可直接上手。',
      tablistAria: '教程分页',
      tabQuickStart: '快速开始',
      tabLegend: '图例与快捷键',
      steps: {
        tryStarterTitle: '1. 运行「极简入门双层流」演示',
        tryStarterDesc: '加载低成本 DeepSeek API 双层工作流，并播放正常流转接力动画。',
        watchReplayTitle: '2. 观看一期自举 60× 真实回放',
        watchReplayDesc: '重温 VibeBaton 在 3 个里程碑中的真实自举轨迹、门禁拦截与熔断升级过程。',
        inspectNodeTitle: '3. 编辑节点配置与模型热切换',
        inspectNodeDesc: '选中画布上的执行节点，可在右侧修改模型或通过 #recipe 链接分享整套工作流。',
      },
      legendTiersTitle: '层级配色与职责说明',
      legendTiers: [
        { key: 'L0', name: 'L0 · 头脑风暴与终审', desc: '在开工前对齐规格需求，并在最终合并前由用户签字把关。' },
        { key: 'L1', name: 'L1 · 规划与里程碑评审', desc: '将主规格拆解为无环任务图，并在里程碑合入前把关质量。' },
        { key: 'L2', name: 'L2 · 核心攻坚与微观审校', desc: '负责核心架构编写、熔断升级接管以及常规任务的逐项审校。' },
        { key: 'L3', name: 'L3 · 并发批量执行', desc: '通过 DeepSeek API 高并发完成大量常规模块与单元测试开发。' },
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
        { keys: '→', desc: '单步前进一帧轨迹事件' },
        { keys: 'Delete / Backspace', desc: '删除当前选中的节点或连线' },
      ],
      dontShowAgain: '下次打开不再自动弹出',
      getStarted: '开始使用',
    },
  },
};
