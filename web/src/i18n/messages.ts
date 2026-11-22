import type { BudgetProfile, CostTier, ExecutionState, NodeType, PresetCategory, Scenario, TraceKind } from '../types/graph';

export type Locale = 'en' | 'zh';

type CredentialKey = 'DEEPSEEK_API_KEY' | 'OPENAI_API_KEY' | 'OPENCODE_API_KEY' | 'ANTHROPIC_API_KEY';

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
  nodeTypes: Record<NodeType, string>;
  nodeStates: Partial<Record<ExecutionState, string>>;
  nodeCard: {
    parallelWorkersTitle: string;
  };
  liveClock: {
    live: string;
    liveBadgeLabel: string;
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
  nodeReadiness: {
    statuses: Record<'ready' | 'cooldown' | 'missing', string>;
    doctorButton: string;
    latency(milliseconds: number): string;
    installHint: string;
    pinModelOverride: string;
  };
  credentials: {
    title: string;
    keyLabels: Record<CredentialKey, string>;
    maskedNote: string;
    manualLoginNote: string;
    save: string;
    clear: string;
    copyCommand: string;
    copyCommandHint: string;
  };
  wizard: {
    steps: {
      preflight: string;
      brainstorm: string;
      launch: string;
    };
    fields: {
      goal: string;
      constraints: string;
      verificationCommand: string;
      nonGoals: string;
    };
    generateRfc: string;
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
    skipBrainstorm: string;
    skipWarning: {
      title: string;
      body: string;
      confirm: string;
      cancel: string;
    };
    switchToReadyPreset: string;
    runModes: Record<'overnight' | 'interactive', string>;
    startRealRun: string;
    launchSummary: {
      title: string;
      budgetLabel: string;
      concurrencyLabel(cap: number): string;
      rolesTitle: string;
      guardsTitle: string;
      guards: readonly string[];
    };
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
        PLANNING: 'PLANNING',
        IN_PROGRESS: 'IN_PROGRESS',
        REVIEWING: 'REVIEWING',
        RUNNING: 'RUNNING',
        PAUSED: 'PAUSED',
        WAITING_HUMAN: 'WAITING_HUMAN',
        READY_FOR_FINAL_GATE: 'READY_FOR_FINAL_GATE',
        COMPLETED: 'COMPLETED',
        FAILED: 'FAILED',
        HALTED: 'HALTED',
        PASSED: 'PASSED',
        PENDING: 'PENDING',
        REJECTED: 'REJECTED',
        CANCELLED: 'CANCELLED',
        ESCALATED: 'ESCALATED',
        UNKNOWN: 'UNKNOWN',
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
      tabTutorial: 'Tutorial',
      steps: {
        tryStarterTitle: '1. Run Starter 2-Tier Flow Demo',
        tryStarterDesc: 'Load the minimal DeepSeek API starter workflow and animate Happy Path playback.',
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
            'L3 (DeepSeek API Workers): Runs routine modules fast in parallel using isolated Git worktrees and file whitelists.',
            'Mechanical Gate + L2 Reviewer: Deterministic unit tests and lint run first before spending senior review quota.',
          ],
        },
        {
          title: '2. Your First Real Run in 5 Steps',
          summary: 'Go from an idea to verified code cleanly from either the Studio UI or Windows PowerShell.',
          points: [
            'Step 1 — Pick a Budget & Preset: Choose Eco, Balanced, or Max Quality and select a green "Ready on Host" workflow on the left.',
            'Step 2 — Click "Start Real Run": Check local CLI tools and API keys in Step 1, then run interactive Brainstorm/RFC checks in Step 2.',
            'Step 3 — Confirm Division & Guards: Review each role model and built-in safety guards in Step 3 before launching.',
            'Step 4 — Watch Live Canvas Sync: Click the top-left "Live Run Workflow" card to see live tasks glow in real time.',
            'Step 5 — Inspect Battle Report & Sign Off: Check Stage Timing, Model Runtime, and approve L0 merge only when tests pass.',
          ],
        },
        {
          title: '3. Beginner FAQ & Troubleshooting',
          summary: 'Quick answers for first-time builders running VibeBaton locally.',
          points: [
            'Q: Why did the canvas show a static preset while running? Click the top-left "Live Run Workflow" card to switch the canvas to live task nodes.',
            'Q: How do I minimize API spend? Use "Starter 2-Tier Flow" or "DeepSeek API Bulk Factory" paired with the Eco budget profile.',
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
    recipePlaza: {
      title: 'Recipe Plaza',
      filters: {
        all: 'All',
        ready_on_host: 'Ready on Host',
        same_family: 'Same-Family',
        bulk_batch: 'Bulk Batch',
        small_project: 'Small Project',
        audit: 'Audit',
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
    nodeReadiness: {
      statuses: { ready: 'Ready', cooldown: 'Cooldown', missing: 'Missing' },
      doctorButton: '5s Doctor',
      latency: (milliseconds) => `${milliseconds} ms latency`,
      installHint: 'Setup Hint',
      pinModelOverride: 'Pin model override',
    },
    credentials: {
      title: 'Credentials Setup',
      keyLabels: {
        DEEPSEEK_API_KEY: 'DeepSeek API Key',
        OPENAI_API_KEY: 'OpenAI API Key',
        OPENCODE_API_KEY: 'DeepSeek API Gateway Key',
        ANTHROPIC_API_KEY: 'Anthropic API Key',
      },
      maskedNote: 'Saved keys stay on this host outside the repository. Configured keys appear masked.',
      manualLoginNote: 'Sign in to Claude, Codex, and other subscription CLIs manually in your terminal.',
      save: 'Save',
      clear: 'Clear',
      copyCommand: 'Copy Command',
      copyCommandHint: 'Copy this command and run it in your terminal.',
    },
    wizard: {
      steps: {
        preflight: 'Preflight & Credentials',
        brainstorm: 'Brainstorm / RFC',
        launch: 'Launch',
      },
      fields: {
        goal: 'Goal',
        constraints: 'Constraints',
        verificationCommand: 'Verification Command',
        nonGoals: 'Non-goals',
      },
      generateRfc: 'Generate RFC',
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
      skipBrainstorm: 'Skip Brainstorm',
      skipWarning: {
        title: 'Skip Brainstorm with an incomplete RFC?',
        body: 'The RFC is missing required sections. Continuing may leave tasks without clear instructions or verification steps.',
        confirm: 'Skip Anyway',
        cancel: 'Cancel',
      },
      switchToReadyPreset: 'Switch to a Ready Preset',
      runModes: { overnight: 'Overnight', interactive: 'Interactive' },
      startRealRun: 'Start Real Run',
      launchSummary: {
        title: 'Role Division & Safety Guards',
        budgetLabel: 'Active Budget Profile',
        concurrencyLabel: (cap) => `max ${cap} parallel`,
        rolesTitle: 'Active Role Dispatch',
        guardsTitle: 'Built-In Runtime Guards',
        guards: [
          'Quota Cooldown: 429 limits isolate only the throttled provider and keep sibling workers moving.',
          'Path Whitelist Guard: Changes outside allowed_files inside Git worktrees revert automatically.',
          'Human Final Gate: Completed milestones wait on dev for L0 approval before touching main.',
        ],
      },
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
      runHistoryLabel: '历史运行切换',
      runHistoryOption: (id, status, passed, total, elapsed) => `${id} · ${status}（${passed}/${total} 任务 · ${elapsed}）`,
      stageTimingTitle: '阶段耗时明细',
      modelRuntimeTitle: '模型运行统计',
      billingTitle: '令牌用量与费用',
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
        PLANNING: '规划中',
        IN_PROGRESS: '进行中',
        REVIEWING: '审校中',
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
      modalStartTitle: '启动真实运行',
      modalReportTitle: '战报详情',
      reportRendered: '渲染视图',
      reportRaw: '原始 Markdown',
      reportCopy: '复制 Markdown',
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
      tabTutorial: '详细教程',
      steps: {
        tryStarterTitle: '1. 运行「极简入门双层流」演示',
        tryStarterDesc: '加载低成本 DeepSeek API 双层工作流，并播放正常流转接力动画。',
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
            'L3（DeepSeek API 并发工人）：在独立 Git Worktree 沙盒目录里高并发开发常规模块，改错不会污染主工作区。',
            '机械门禁 + L2 审校：先免费跑本地测试和静态检查抓低级错误，全过后再请高阶审校官把关，省钱又稳。',
          ],
        },
        {
          title: '2. 小白五步跑通首次真实任务',
          summary: '无需记忆复杂命令，跟随侧边栏和向导弹窗五步就能启动一个安全的通宵或交互任务。',
          points: [
            '第 1 步（选预算与绿色预设）：左侧选择「节省 / 均衡 / 质量优先」预算档位，挑一个显示绿色「本机就绪」的工作流。',
            '第 2 步（点开「启动真实运行」）：第 1 页核对本机 CLI 与 API 密钥是否就绪；第 2 页用结构化表单一键生成并体检 RFC 需求文档。',
            '第 3 步（核对分工与安全护栏）：第 3 页确认各个角色对应的模型与并发上限、429 冷却保护与路径白名单守卫后再发车。',
            '第 4 步（画布实时同步看板）：发车或已有运行后，点击左上角「实时运行工作流」卡片，中间画布会实时亮起每个里程碑和任务节点。',
            '第 5 步（查看战报与 L0 终审合入）：任务收官后可点开中文战报、阶段耗时、模型耗时与单任务审计详情，确认无误后再合并主分支。',
          ],
        },
        {
          title: '3. 新手常见问题排查（FAQ）',
          summary: '遇到困惑先看这里，覆盖 90% 的初上手疑问。',
          points: [
            '问：为什么运行中左侧和中间画布没有自动显示真实任务？答：预设栏显示的是工作流蓝图，请点击左上角「实时运行工作流」卡片切换到真实任务 DAG 画布。',
            '问：怎么配置最省钱？答：新手建议选择「极简入门双层流」或「DeepSeek API 批量工厂」，并将预算档位切到「节省」。',
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
    recipePlaza: {
      title: '工作流广场',
      filters: {
        all: '全部',
        ready_on_host: '本机就绪',
        same_family: '同家族',
        bulk_batch: '批量处理',
        small_project: '小型项目',
        audit: '审计',
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
    nodeReadiness: {
      statuses: { ready: '就绪', cooldown: '冷却中', missing: '缺失' },
      doctorButton: '5 秒诊断',
      latency: (milliseconds) => `延迟 ${milliseconds} 毫秒`,
      installHint: '配置提示',
      pinModelOverride: '固定模型覆盖设置',
    },
    credentials: {
      title: '凭据设置',
      keyLabels: {
        DEEPSEEK_API_KEY: 'DeepSeek API 密钥',
        OPENAI_API_KEY: 'OpenAI API 密钥',
        OPENCODE_API_KEY: 'DeepSeek API 网关密钥',
        ANTHROPIC_API_KEY: 'Anthropic API 密钥',
      },
      maskedNote: '密钥保存在本机的用户目录中。已配置的密钥会脱敏显示。',
      manualLoginNote: 'Claude 和 Codex 等订阅命令行工具需在终端中手动登录。',
      save: '保存',
      clear: '清除',
      copyCommand: '复制命令',
      copyCommandHint: '复制此命令并在终端中执行。',
    },
    wizard: {
      steps: {
        preflight: '运行前检查与凭据',
        brainstorm: '头脑风暴与 RFC',
        launch: '启动',
      },
      fields: {
        goal: '目标',
        constraints: '约束',
        verificationCommand: '验证命令',
        nonGoals: '非目标',
      },
      generateRfc: '生成 RFC',
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
      skipBrainstorm: '跳过头脑风暴',
      skipWarning: {
        title: 'RFC 尚未完整，仍要跳过头脑风暴？',
        body: '此 RFC 缺少必需章节。继续执行时，任务要求或验证步骤可能不够明确。',
        confirm: '仍然跳过',
        cancel: '取消',
      },
      switchToReadyPreset: '切换到已就绪的预设',
      runModes: { overnight: '通宵无人值守', interactive: '交互式' },
      startRealRun: '启动真实运行',
      launchSummary: {
        title: '模型分工与安全护栏',
        budgetLabel: '当前预算档位',
        concurrencyLabel: (cap) => `最大并发 ${cap}`,
        rolesTitle: '当前角色分工',
        guardsTitle: '内置安全与自愈机制',
        guards: [
          '配额防线：触发 429 限流仅冷却对应供应方并支持回退接力，不拖垮全局。',
          '路径白名单物理守卫：Git Worktree 中越界改动在合入前自动拦截回滚。',
          '人类 L0 终审闸门：全部里程碑仅先合入 dev，待人工终审确认后再合并主干。',
        ],
      },
    },
  },
};
