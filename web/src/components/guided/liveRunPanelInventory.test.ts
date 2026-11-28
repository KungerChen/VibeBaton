/**
 * Every field and control of the Pro `LiveRunPanel`, the place the workbench shows it now, and an assertion that
 * it is there (RFC Phase 2, acceptance criterion 5). Read it next to `LiveRunPanel.tsx`, top to bottom.
 */
import { act, createElement, Fragment, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { BatonApiClient, RunTaskDetail } from '../../api/client';
import { buildLiveRunGraph } from '../../engine/liveRunGraph';
import { MESSAGES } from '../../i18n/messages';
import type { LiveRunSnapshot, RunListItem } from '../../types/graph';
import { BattleReportModal } from '../inspector/BattleReportModal';
import liveRunPanelSource from '../inspector/LiveRunPanel.tsx?raw';
import reportModalSource from '../inspector/BattleReportModal.tsx?raw';
import { BottomDock, DOCK_OPEN_KEY, DOCK_TAB_KEY, type BottomDockProps } from './BottomDock';
import { RunDecisionPanel, RunOverviewPanel, shortRunId } from './ContextDrawer';
import contextDrawerSource from './ContextDrawer.tsx?raw';
import brainstormSource from './GuidedBrainstormStep.tsx?raw';
import workbenchSource from './GuidedWorkbench.tsx?raw';
import { NodeDetailDrawer, type NodeDetailDrawerProps } from './NodeDetailDrawer';

const en = MESSAGES.en;
const inspector = en.inspector;
const relay = en.guided.relay;
const RUN_ID = 'run-20261127-abc123';
const SHORT = shortRunId(RUN_ID);

/** One snapshot for every place below. */
const snapshot: LiveRunSnapshot = {
  run: { id: RUN_ID, status: 'RUNNING' },
  milestones: [{ id: 'M1', title: 'Core', status: 'RUNNING' }],
  tasks: [{
    id: 'T1', milestone_id: 'M1', title: 'Write the greeting', status: 'RUNNING', tier: 'critical',
    current_role: 'critical_executor', self_heal_count: 2, review_reject_count: 1, escalated: 1,
    last_error: 'pytest failed: 1 error', allowed_files: '["hello.py","README.md"]',
  }],
  events: [
    { id: 1, kind: 'run_created', message: 'Run created in overnight mode', created_at: 100 },
    { id: 2, kind: 'role_invoked', actor: 'critical_executor:gpt-5', task_id: 'T1', created_at: 101,
      message: 'Invoking critical_executor (codex_sub/gpt-5)', payload_json: JSON.stringify({ artifact_key: 'T1_exec_1' }) },
    { id: 3, kind: 'task_failed', task_id: 'T1', message: '门禁失败', created_at: 102 },
  ],
  quotas: [],
  telemetry: {
    elapsed_sec: 75,
    server_now: 1000,
    stages: [
      { id: 'PANEL', kind: 'panel', title: 'Panel', status: 'PASSED', wall_sec: 12, task_sum_sec: 0,
        passed_tasks: 0, total_tasks: 0, started_at: null, is_active: false },
      { id: 'PLANNING', kind: 'planning', title: 'Plan', status: 'PASSED', wall_sec: 30, task_sum_sec: 0,
        passed_tasks: 0, total_tasks: 0, started_at: null, is_active: false },
      { id: 'M1', kind: 'milestone', title: 'Core', status: 'RUNNING', wall_sec: 45, task_sum_sec: 40,
        passed_tasks: 0, total_tasks: 1, started_at: 990, is_active: true },
    ],
    models: [{
      actor: 'critical_executor:gpt-5', role: 'critical_executor', provider: 'codex_sub', display_provider: 'codex_sub',
      model: 'gpt-5', calls: 3, duration_sec: 40, estimated: true, avg_sec: 13.3, share_pct: 100,
      prompt_tokens: 1200, completion_tokens: 300, cost_usd: 0.0125, active_started_at: null,
    }],
    billing: { total_prompt_tokens: 1200, total_completion_tokens: 300, total_cached_tokens: 100, total_tokens: 1600,
      total_cost_usd: 0.0125, has_exact_billing: true, total_calls: 3, reported_calls: 2 },
    task_timings: { T1: { duration_sec: 40, started_at: null, is_active: false } },
    attention: { category: 'long_cooldown', severity: 'warning', title: 'Provider quota cooldown',
      message: 'Waiting 60s for codex', action_hint: '', milestone_id: 'M1', task_id: 'T1', created_at: 99 },
  },
};
const unreported: LiveRunSnapshot = {
  ...snapshot,
  run: { id: RUN_ID, status: 'PAUSED' },
  tasks: [],
  telemetry: { ...snapshot.telemetry!, attention: null,
    models: [{ ...snapshot.telemetry!.models[0], prompt_tokens: 0, completion_tokens: 0, cost_usd: null }],
    billing: { total_prompt_tokens: 0, total_completion_tokens: 0, total_cached_tokens: 0, total_tokens: 0,
      total_cost_usd: null, has_exact_billing: false, total_calls: 2, reported_calls: 0 } },
};
const runs: RunListItem[] = [
  { id: RUN_ID, status: 'RUNNING', mode: 'overnight', created_at: 1, updated_at: 2, finished_at: null, elapsed_sec: 75,
    passed_tasks: 0, total_tasks: 1, passed_milestones: 0, total_milestones: 1 },
  { id: 'run-older-def456', status: 'COMPLETED', mode: 'overnight', created_at: 0, updated_at: 1, finished_at: 1,
    elapsed_sec: 30, passed_tasks: 2, total_tasks: 2, passed_milestones: 1, total_milestones: 1 },
];
const taskDetail: RunTaskDetail = {
  run_id: RUN_ID, task_id: 'T1', milestone_id: 'M1', title: 'Write the greeting', tier: 'critical', status: 'RUNNING',
  summary: 'Writing hello.py.', attempts: 1, test_status: 'not_run', provider: 'codex_sub', model: 'gpt-5',
  elapsed_sec: 40, cost_usd: 0.0125, changed_files: [], review_verdict: null,
};

const storage = new Map<string, string>();
function stubWindow() {
  vi.stubGlobal('window', { HTMLIFrameElement: class HTMLIFrameElement {}, localStorage: {
    getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } });
}

const client = {
  getRunReport: vi.fn(), getPricing: vi.fn(), syncPricing: vi.fn(), saveCustomPricing: vi.fn(),
} as unknown as BatonApiClient;

function overview(shown: LiveRunSnapshot, extra: Partial<Parameters<typeof RunOverviewPanel>[0]> = {}) {
  return renderToStaticMarkup(createElement(RunOverviewPanel, {
    snapshot: shown, view: buildLiveRunGraph(shown, 'en'), locale: 'en', liveNowSec: 1010,
    controls: { busy: false, synced: true, changeRun: vi.fn() }, onStop: vi.fn(), client, onToast: vi.fn(),
    history: { runs, onSelect: vi.fn() }, onSelectTask: vi.fn(), ...extra,
  }));
}

function dock(tab: 'timeline' | 'terminal' | 'gates' | null, extra: Partial<BottomDockProps> = {}) {
  storage.clear();
  if (tab) { storage.set(DOCK_OPEN_KEY, 'open'); storage.set(DOCK_TAB_KEY, tab); }
  return renderToStaticMarkup(createElement(BottomDock, { runId: RUN_ID, snapshot, receipts: [], locale: 'en',
    loadArtifact: vi.fn(), ...extra }));
}

/** The task panel loads its detail first; the snapshot's own task facts are then under its technical details. */
async function taskPanel(audit: NodeDetailDrawerProps['audit']): Promise<string> {
  let view: ReactNode = null;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = { nodeType: 1, tagName: 'DIV', ownerDocument: null, addEventListener() {} };
  const root = createRoot(container as unknown as HTMLElement);
  const props: NodeDetailDrawerProps = { inline: true, runId: RUN_ID, taskId: 'T1', locale: 'en', onClose: () => {},
    fetcher: async () => taskDetail, audit };
  function Probe() { view = NodeDetailDrawer(props); return null; }
  await act(async () => { root.render(createElement(Probe)); });
  const html = renderToStaticMarkup(createElement(Fragment, null, view));
  act(() => root.unmount());
  return html;
}

const places = {} as {
  overview: string; overviewPaused: string; dockCollapsed: string; dockReconnecting: string; dockSyncing: string;
  dockFailed: string; timeline: string; terminal: string; taskPanel: string; taskPanelNoEvents: string;
  runDecision: string; report: string;
};

beforeAll(async () => {
  stubWindow();
  places.overview = overview(snapshot);
  places.overviewPaused = overview(unreported);
  places.dockCollapsed = dock(null);
  places.dockReconnecting = dock(null, { reconnecting: true });
  places.dockSyncing = dock(null, { syncStatus: 'loading' });
  places.dockFailed = dock(null, { syncStatus: 'error' });
  places.timeline = dock('timeline');
  places.terminal = dock('terminal');
  places.taskPanel = await taskPanel({ task: snapshot.tasks[0], events: snapshot.events.filter((event) => event.task_id === 'T1') });
  places.taskPanelNoEvents = await taskPanel({ task: snapshot.tasks[0], events: [] });
  places.runDecision = renderToStaticMarkup(createElement(RunDecisionPanel, { runId: RUN_ID, question: 'Change the plan?',
    milestoneId: 'M1', locale: 'en', busy: false, onDecide: vi.fn() }));
  places.report = renderToStaticMarkup(createElement(BattleReportModal, { report: { runId: RUN_ID, lang: 'en', markdown: '# Report' },
    locale: 'en', onClose: () => {}, onToast: () => {} }));
});

afterAll(() => vi.unstubAllGlobals());

interface InventoryItem {
  /** What LiveRunPanel shows. */
  field: string;
  /** Where the workbench shows it now. */
  to: string;
  /** The `messages.inspector` keys LiveRunPanel uses for this field. */
  keys: string[];
  check(): void;
}

const inventory: InventoryItem[] = [
  {
    field: 'Reconnect badge and selected-run sync state',
    to: 'BottomDock bar, right side',
    keys: ['reconnecting', 'runSyncing', 'runSyncFailed'],
    check: () => {
      expect(places.dockReconnecting).toContain(inspector.reconnecting);
      expect(places.dockSyncing).toContain(inspector.runSyncing);
      expect(places.dockFailed).toContain(inspector.runSyncFailed);
    },
  },
  {
    field: 'Run history',
    to: 'RunOverviewPanel upper part, run history select',
    keys: ['runHistoryLabel', 'runHistoryOption'],
    check: () => {
      expect(places.overview).toContain(inspector.runHistoryLabel);
      expect(places.overview).toContain('<select');
      expect(places.overview).toContain(inspector.runHistoryOption('run-older-def456', 'Completed', 2, 2, '30.0s'));
    },
  },
  {
    field: 'Start a run',
    to: 'Blueprint launch card (GuidedBrainstormStep with GuidedLaunchBar); no new control',
    keys: ['startRealRun'],
    check: () => {
      expect(workbenchSource).toMatch(/shownStep === 'brainstorm' && lineup[\s\S]*<GuidedBrainstormStep/);
      expect(brainstormSource).toContain('<GuidedLaunchBar');
    },
  },
  {
    field: 'Battle report button',
    to: 'RunOverviewPanel upper part, actions',
    keys: ['battleReport'],
    check: () => expect(places.overview).toContain(en.guided.signOff.battleReport),
  },
  {
    field: 'Run status badge',
    to: 'RunOverviewPanel upper part',
    keys: ['runStatuses'],
    check: () => {
      expect(places.overview).toMatch(/data-field="status-badge"[^>]*>Running</);
      expect(places.overviewPaused).toMatch(/data-field="status-badge"[^>]*>Paused</);
    },
  },
  {
    field: 'Run ID',
    to: 'RunOverviewPanel technical details',
    keys: [],
    check: () => expect(places.overview).toContain(`<code>${RUN_ID}</code>`),
  },
  {
    field: 'Attention line',
    to: 'RunOverviewPanel upper part',
    keys: [],
    check: () => {
      expect(places.overview).toContain(en.attention.badges.long_cooldown);
      expect(places.overview).toContain('Waiting 60s for codex');
      expect(places.overviewPaused).not.toContain('data-field="attention"');
    },
  },
  {
    field: 'Pause',
    to: 'RunOverviewPanel upper part, actions (RUNNING)',
    keys: ['pauseRun'],
    check: () => {
      expect(places.overview).toContain(relay.overview.pauseRun(SHORT));
      expect(places.overview).not.toContain(relay.overview.resumeRun(SHORT));
    },
  },
  {
    field: 'Resume',
    to: 'RunOverviewPanel upper part, actions (PAUSED)',
    keys: ['resumeRun'],
    check: () => {
      expect(places.overviewPaused).toContain(relay.overview.resumeRun(SHORT));
      expect(places.overviewPaused).not.toContain(relay.overview.pauseRun(SHORT));
    },
  },
  {
    field: 'Stop (named by the RFC; LiveRunPanel itself has no stop)',
    to: 'RunOverviewPanel upper part, actions, through the workbench stop confirmation',
    keys: [],
    check: () => {
      expect(places.overview).toContain(relay.overview.stopRun(SHORT));
      expect(overview(snapshot, { onStop: undefined })).not.toContain(relay.overview.stopRun(SHORT));
    },
  },
  {
    field: 'Human decision: note, approve, reject',
    to: 'RunDecisionPanel (run-level) in the drawer; task-level decisions keep the GuidedDecisionDrawer',
    keys: ['decisionNote', 'approve', 'reject'],
    check: () => {
      expect(places.runDecision).toContain(inspector.decisionNote);
      expect(places.runDecision).toContain('<textarea');
      expect(places.runDecision).toContain(relay.approveRun(SHORT));
      expect(places.runDecision).toContain(relay.rejectRun(SHORT));
    },
  },
  {
    field: 'Stage timing with the total and a live mark',
    to: 'RunOverviewPanel technical details; the total is also in the upper part',
    keys: ['stageTimingTitle', 'totalElapsed', 'planningStageLabel', 'panelStageLabel'],
    check: () => {
      expect(places.overview).toContain(inspector.stageTimingTitle);
      expect(places.overview).toContain(inspector.totalElapsed('1m 25s'));
      expect(places.overview).toContain(inspector.planningStageLabel);
      expect(places.overview).toContain(inspector.panelStageLabel);
      expect(places.overview).toContain('M1 · Core');
      expect(places.overview).toContain('0/1');
      expect(places.overview).toContain('55s');
      expect(places.overview).toContain(en.liveClock.live);
    },
  },
  {
    field: 'Model runtime: model, role, calls, average, share and estimate mark',
    to: 'RunOverviewPanel technical details',
    keys: ['modelRuntimeTitle', 'callCount', 'avgDuration', 'estimatedTag'],
    check: () => {
      expect(places.overview).toContain(inspector.modelRuntimeTitle);
      expect(places.overview).toContain('OpenAI Codex / gpt-5');
      expect(places.overview).toContain('L2 Critical Executor');
      expect(places.overview).toContain(inspector.callCount(3));
      expect(places.overview).toContain(inspector.avgDuration('13.3s'));
      expect(places.overview).toContain('100.0%');
      expect(places.overview).toContain(`(${inspector.estimatedTag})`);
    },
  },
  {
    field: 'Billing: total cost, total tokens, tokens and cost per model',
    to: 'RunOverviewPanel upper part (total) and technical details (tokens, per model)',
    keys: ['billingTotalCost', 'billingTokens', 'billingPerModel'],
    check: () => {
      expect(places.overview).toContain(inspector.billingTotalCost('$0.0125'));
      expect(places.overview).toContain(inspector.billingTokens('1,200', '300', '100'));
      expect(places.overview).toContain(inspector.billingPerModel('1,200', '300'));
    },
  },
  {
    field: 'Not reported and coverage',
    to: 'RunOverviewPanel upper part (total) and technical details (per model)',
    keys: [],
    check: () => {
      expect(places.overview).toContain(inspector.billingCoverage(2, 3));
      expect(places.overviewPaused).toContain(inspector.billingTotalCost(inspector.billingNotReported));
      expect(places.overviewPaused).toContain(inspector.billingCoverage(0, 2));
      expect(places.overviewPaused.match(new RegExp(`>${inspector.billingNotReported}<`, 'g'))).toHaveLength(1);
      expect(places.overviewPaused).not.toContain('$0.00');
    },
  },
  {
    field: 'Pricing',
    to: 'RunOverviewPanel upper part, actions (opens PricingModal)',
    keys: [],
    check: () => expect(places.overview).toContain(en.pricing.openButton),
  },
  {
    field: 'Task list: ID, title, status, time, tier, current role; a click selects the task',
    to: 'RunOverviewPanel technical details; a row selects the task on the graph and the drawer shows its panel',
    keys: ['tasksAria', 'noTasks'],
    check: () => {
      expect(places.overview).toContain(inspector.tasksAria);
      const row = /<button[^>]*data-task="T1"[\s\S]*?<\/button>/.exec(places.overview)?.[0] ?? '';
      for (const text of ['T1', 'Write the greeting', 'Running', '40.0s', 'Critical', 'L2 Critical Executor']) {
        expect(row, text).toContain(text);
      }
      expect(places.overviewPaused).toContain(inspector.noTasks);
    },
  },
  {
    field: 'Task details: model and time',
    to: 'Task panel (NodeDetailDrawer inline) technical details, from the task detail endpoint',
    keys: ['taskDetailModel', 'taskDetailDuration'],
    check: () => {
      expect(places.taskPanel).toContain('<dd data-field="model"><code>OpenAI Codex / gpt-5</code></dd>');
      expect(places.taskPanel).toContain('<dd data-field="elapsed">40.0s</dd>');
    },
  },
  {
    field: 'Task details: self-heal, review fix and escalation counters; allowed files; last error; task events',
    to: 'Task panel (NodeDetailDrawer inline) technical details, from the snapshot',
    keys: ['taskDetailCounters', 'taskDetailFiles', 'taskDetailLastError', 'taskDetailEvents', 'taskDetailNoEvents'],
    check: () => {
      expect(places.taskPanel).toContain(inspector.taskDetailCounters(2, 1, 1));
      expect(places.taskPanel).toContain(inspector.taskDetailFiles);
      expect(places.taskPanel).toContain('<code>hello.py</code>');
      expect(places.taskPanel).toContain('<code>README.md</code>');
      expect(places.taskPanel).toContain(inspector.taskDetailLastError);
      expect(places.taskPanel).toContain('pytest failed: 1 error');
      expect(places.taskPanel).toContain(inspector.taskDetailEvents);
      expect(places.taskPanel).toContain('Role Invoked');
      expect(places.taskPanel).toContain('Task Failed');
      expect(places.taskPanelNoEvents).toContain(inspector.taskDetailNoEvents);
    },
  },
  {
    field: 'Event log with the original note',
    to: 'BottomDock Timeline tab; the latest event is also on the collapsed bar',
    keys: ['eventLogTitle', 'eventLogAria', 'originalNote', 'noEvents'],
    check: () => {
      expect(places.timeline).toContain(en.guided.dock.tabs.timeline);
      expect(places.timeline).toContain(`aria-label="${inspector.eventLogAria}"`);
      expect(places.timeline).toContain('Run Created');
      expect(places.timeline).toContain(inspector.originalNote);
      expect(places.timeline).toContain('门禁失败');
      expect(places.dockCollapsed).toContain('Task Failed');
      expect(dock(null, { snapshot: { ...snapshot, events: [] } })).toContain(en.guided.dock.noEvents);
    },
  },
  {
    field: 'Battle report: rendered or raw, and copy',
    to: 'BattleReportModal, opened from RunOverviewPanel; the same component LiveRunPanel opens',
    keys: ['modalReportTitle', 'reportRendered', 'reportRaw', 'reportCopy', 'copiedInline'],
    check: () => {
      for (const text of [inspector.modalReportTitle, inspector.reportRendered, inspector.reportRaw, inspector.reportCopy]) {
        expect(places.report, text).toContain(text);
      }
      expect(liveRunPanelSource).toContain('<BattleReportModal');
      expect(contextDrawerSource).toContain('<BattleReportModal');
      expect(liveRunPanelSource).not.toContain('<Modal');
    },
  },
];

/** LiveRunPanel copy that does not move, and why. */
const notMigrated: Record<string, string> = {
  liveSectionAria: 'The Pro panel\'s own section label; the drawer and the dock have their own labels.',
  liveTitle: 'The Pro panel\'s own heading.',
  taskDetailTitle: 'The heading of the Pro task accordion; the task panel has its own title.',
  noRuns: 'The workbench has no Build stage without a run; it stays on the blueprint.',
};

/** Pro-only controls that are not in the RFC list and stay in the Pro view. */
const notMigratedFields = [
  { field: 'Share Case', reason: 'Not in the RFC list of fields; the Pro view keeps it.', source: 'messages.transfer.liveRun.shareCase' },
];

describe('LiveRunPanel field inventory', () => {
  test.each(inventory)('$field -> $to', ({ check }) => check());

  test('every messages.inspector key LiveRunPanel uses is migrated or listed with a reason', () => {
    const source = liveRunPanelSource + reportModalSource;
    const used = new Set([...source.matchAll(/messages\.inspector\.(\w+)/g)].map((match) => match[1]));
    const migrated = new Set(inventory.flatMap((item) => item.keys));
    expect(used.size).toBeGreaterThan(30);
    const unaccounted = [...used].filter((key) => !migrated.has(key) && !Object.hasOwn(notMigrated, key));
    expect(unaccounted).toEqual([]);
    // The inventory names only keys the panel really uses, and no key is on both lists.
    expect([...migrated, ...Object.keys(notMigrated)].filter((key) => !used.has(key))).toEqual([]);
    expect([...migrated].filter((key) => Object.hasOwn(notMigrated, key))).toEqual([]);
    for (const reason of Object.values(notMigrated)) expect(reason.length).toBeGreaterThan(10);
  });

  test('Share Case stays in the Pro view and is not in the workbench', () => {
    for (const { source } of notMigratedFields) {
      expect(liveRunPanelSource).toContain(source);
      expect(contextDrawerSource).not.toContain(source);
    }
  });
});
