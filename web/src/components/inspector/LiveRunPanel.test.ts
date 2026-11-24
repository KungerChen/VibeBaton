import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { assert, expect, test, vi } from 'vitest';
import { BatonApiClient } from '../../api/client';
import { I18nProvider } from '../../i18n';
import type { LiveRunSnapshot, RunAttentionState, StageTelemetry } from '../../types/graph';
import { LiveRunPanel } from './LiveRunPanel';

// The Node test runner needs only the host methods used to render the panel and open its dialog.
function createPanelContainer() {
  type ClickListener = (event: { type: string; target: TestNode; button: number }) => void;
  const listeners = new Map<string, ClickListener>();
  const document = {
    createElement: (tag: string) => new TestNode(tag),
    createElementNS: (_namespace: string, tag: string) => new TestNode(tag),
    createTextNode: (text: string) => new TestNode('#text', text),
    addEventListener() {},
  };

  class TestNode {
    readonly nodeType: number;
    readonly ownerDocument = document;
    readonly children: TestNode[] = [];
    readonly style = {};
    parentNode: TestNode | null = null;
    open = false;

    constructor(readonly tagName: string, public textContent = '') {
      this.nodeType = tagName === '#text' ? 3 : 1;
    }

    addEventListener(type: string, callback: ClickListener, capture: boolean) {
      if (type === 'click' && !capture) listeners.set(type, callback);
    }

    setAttribute() {}
    removeAttribute() {}
    showModal() { this.open = true; }
    close() { this.open = false; }

    appendChild(child: TestNode) {
      this.insertBefore(child, null);
    }

    insertBefore(child: TestNode, sibling: TestNode | null) {
      const index = sibling ? this.children.indexOf(sibling) : this.children.length;
      this.children.splice(index, 0, child);
      child.parentNode = this;
    }

    removeChild(child: TestNode) {
      this.children.splice(this.children.indexOf(child), 1);
      child.parentNode = null;
    }

    get text(): string {
      return this.textContent + this.children.map((child) => child.text).join('');
    }

    find(tag: string, text?: string): TestNode | undefined {
      if (this.tagName === tag && (text === undefined || this.text === text)) return this;
      for (const child of this.children) {
        const match = child.find(tag, text);
        if (match) return match;
      }
    }
  }

  return {
    container: new TestNode('DIV'),
    click(target: TestNode) {
      const listener = listeners.get('click');
      if (!listener) throw new Error('Missing React click listener');
      listener({ type: 'click', target, button: 0 });
    },
  };
}

test.each([
  { locale: 'en', label: 'API Pricing', close: 'Close' },
  { locale: 'zh', label: '模型单价', close: '关闭' },
])('opens the pricing catalog from the $locale header without fetching in demo mode', async ({ locale, label, close }) => {
  const fetchImpl = vi.fn<typeof fetch>();
  const client = new BatonApiClient('', fetchImpl);
  const getPricing = vi.spyOn(client, 'getPricing');
  const { container, click } = createPanelContainer();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', {
    HTMLIFrameElement: class HTMLIFrameElement {},
    localStorage: { getItem: () => locale },
  });
  const root = createRoot(container as unknown as HTMLElement);

  try {
    await act(async () => root.render(createElement(I18nProvider, {
      children: createElement(LiveRunPanel, {
        client,
        visible: true,
        onSelectRunId: () => {},
        onToast: () => {},
      }),
    })));

    expect(container.find('dialog')).toBeUndefined();
    expect(getPricing).not.toHaveBeenCalled();
    const trigger = container.find('button', label);
    assert(trigger, `Missing ${label} button`);
    await act(async () => click(trigger));

    const dialog = container.find('dialog');
    expect(dialog?.open).toBe(true);
    expect(dialog?.find('h2', label)).toBeDefined();
    expect(dialog?.find('code', 'deepseek-flash')).toBeDefined();
    expect(getPricing).toHaveBeenCalledTimes(1);

    const closeButton = dialog?.find('button', close);
    assert(closeButton, `Missing ${close} button`);
    await act(async () => click(closeButton));
    expect(container.find('dialog')).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  } finally {
    try {
      act(() => root.unmount());
    } finally {
      vi.unstubAllGlobals();
    }
  }
});

test('renders the role-completed billing summary next to the pricing action', () => {
  const liveSnapshot: LiveRunSnapshot = {
    run: { id: 'run-billed', status: 'COMPLETED' },
    milestones: [],
    tasks: [],
    events: [],
    quotas: [],
    // Match the telemetry returned by the SSE billing test after a role_completed event.
    telemetry: {
      elapsed_sec: 2,
      stages: [],
      models: [{
        actor: 'bulk_worker:flash',
        role: 'bulk_worker',
        provider: 'deepseek_http',
        display_provider: 'DSH',
        model: 'flash',
        calls: 1,
        duration_sec: 2,
        estimated: false,
        avg_sec: 2,
        share_pct: 100,
        prompt_tokens: 120,
        completion_tokens: 30,
        cost_usd: 0.0125,
      }],
      billing: {
        total_prompt_tokens: 120,
        total_completion_tokens: 30,
        total_cached_tokens: 40,
        total_tokens: 150,
        total_cost_usd: 0.0125,
        has_exact_billing: true,
      },
    },
  };
  const panel = renderToStaticMarkup(createElement(LiveRunPanel, {
    client: new BatonApiClient(),
    visible: true,
    liveSnapshot,
    onSelectRunId: () => {},
    onToast: () => {},
  }));

  expect(panel).toMatch(/Model Runtime<\/h3>\s*<button\b[^>]*>API Pricing<\/button>/);
  expect(panel).toContain('Total cost $0.0125');
  expect(panel).toContain('Prompt 120 · Completion 30 · Cached 40');
});

test.each([
  { status: 'GATE_CHECKING', startedAt: null, afterTick: '1m 30s' },
  { status: 'COOLDOWN', startedAt: null, afterTick: '1m 30s' },
  { status: 'RUNNING', startedAt: 112, afterTick: '1m 33s' },
])('renders the $status task duration from the snapshot and its in-flight timing', ({ status, startedAt, afterTick }) => {
  const snapshot: LiveRunSnapshot = {
    run: { id: 'run-active', status: 'RUNNING' },
    milestones: [],
    tasks: [{ id: 'T1', title: 'Build client', status }],
    events: [],
    quotas: [],
    telemetry: {
      elapsed_sec: 100,
      server_now: 120,
      stages: [],
      models: [],
      task_timings: { T1: { duration_sec: 90, started_at: startedAt, is_active: true } },
    },
  };
  const client = new BatonApiClient();

  function renderTaskHeader(liveNowSec: number) {
    const panel = renderToStaticMarkup(createElement(LiveRunPanel, {
      client,
      visible: true,
      liveSnapshot: snapshot,
      liveNowSec,
      onSelectRunId: () => {},
      onToast: () => {},
    }));
    return panel.match(/<button\b[^>]*aria-expanded="false"[^>]*>.*?<\/button>/s)?.[0];
  }

  expect(renderTaskHeader(120)).toContain('>1m 30s</span>');
  expect(renderTaskHeader(123)).toContain(`>${afterTick}</span>`);
});

test('renders a telemetry attention line above the task accordion when present', () => {
  const attention: RunAttentionState = {
    category: 'long_cooldown',
    severity: 'warning',
    title: 'Provider quota cooldown',
    message: 'Provider quota recovers in five minutes.',
    action_hint: 'The run retries automatically.',
    milestone_id: 'M1',
    task_id: 'T1',
    created_at: 120,
  };
  const client = new BatonApiClient();

  function renderPanel(runAttention: RunAttentionState | null) {
    const liveSnapshot: LiveRunSnapshot = {
      run: { id: 'run-active', status: 'RUNNING' },
      milestones: [],
      tasks: [{ id: 'T1', title: 'Build client', status: 'COOLDOWN' }],
      events: [],
      quotas: [],
      telemetry: { elapsed_sec: 120, stages: [], models: [], attention: runAttention },
    };
    return renderToStaticMarkup(createElement(LiveRunPanel, {
      client,
      visible: true,
      liveSnapshot,
      onSelectRunId: () => {},
      onToast: () => {},
    }));
  }

  const panel = renderPanel(attention);
  expect(panel).toMatch(/<p[^>]*>.*?Provider quota recovers in five minutes\.<\/p>.*?class="task-accordion/s);
  expect(panel).toContain('aria-expanded="false"');
  expect(renderPanel(null)).not.toContain(attention.message);
});

const shareCaseSnapshot: LiveRunSnapshot = {
  run: { id: 'run-shared', status: 'COMPLETED' },
  milestones: [],
  tasks: [],
  events: [],
  quotas: [],
};

const planningStage: StageTelemetry = {
  id: 'PLANNING',
  kind: 'planning',
  title: 'DAG Planning',
  status: 'PASSED',
  wall_sec: 8,
  task_sum_sec: 0,
  passed_tasks: 0,
  total_tasks: 0,
  started_at: null,
  is_active: false,
};

const panelStage: StageTelemetry = {
  id: '00_PANEL',
  kind: 'panel',
  title: 'Panel & Synthesis',
  status: 'PASSED',
  wall_sec: 12,
  task_sum_sec: 0,
  passed_tasks: 0,
  total_tasks: 0,
  started_at: null,
  is_active: false,
};

test.each([
  { locale: 'en' as const, heading: 'Stage Timing', label: 'Specialist Panel' },
  { locale: 'zh' as const, heading: '阶段耗时明细', label: '专家会诊' },
])('renders the 00_PANEL stage card only when the stage exists ($locale)', ({ locale, heading, label }) => {
  function renderStages(stages: StageTelemetry[]) {
    vi.stubGlobal('window', { localStorage: { getItem: () => locale } });
    try {
      return renderToStaticMarkup(createElement(I18nProvider, {
        children: createElement(LiveRunPanel, {
          client: new BatonApiClient(),
          visible: true,
          liveSnapshot: {
            run: { id: 'run-panel', status: 'COMPLETED' },
            milestones: [],
            tasks: [],
            events: [],
            quotas: [],
            telemetry: { elapsed_sec: 20, stages, models: [] },
          },
          onSelectRunId: () => {},
          onToast: () => {},
        }),
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  }

  const panel = renderStages([panelStage, planningStage]);
  expect(panel).toContain(heading);
  expect(panel).toContain(label);
  expect(panel).not.toContain('00_PANEL · Panel & Synthesis');

  const withoutPanel = renderStages([planningStage]);
  expect(withoutPanel).toContain(heading);
  expect(withoutPanel).not.toContain(label);
});

test('renders Share Case beside Battle Report only when a case export handler is provided', () => {
  const client = new BatonApiClient();
  const renderPanel = (onOpenCaseExport?: (runId: string) => void) => renderToStaticMarkup(createElement(LiveRunPanel, {
    client,
    visible: true,
    liveSnapshot: shareCaseSnapshot,
    onSelectRunId: () => {},
    onToast: () => {},
    onOpenCaseExport,
  }));

  expect(renderPanel(() => {})).toMatch(/Battle Report<\/button>\s*<button\b[^>]*>Share Case<\/button>/);
  expect(renderPanel()).not.toContain('Share Case');
});

test('forwards the selected run id when Share Case is clicked', async () => {
  const onOpenCaseExport = vi.fn<(runId: string) => void>();
  const { container, click } = createPanelContainer();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', {
    HTMLIFrameElement: class HTMLIFrameElement {},
    localStorage: { getItem: () => 'en' },
  });
  const root = createRoot(container as unknown as HTMLElement);

  try {
    await act(async () => root.render(createElement(I18nProvider, {
      children: createElement(LiveRunPanel, {
        client: new BatonApiClient(),
        visible: true,
        liveSnapshot: shareCaseSnapshot,
        onSelectRunId: () => {},
        onToast: () => {},
        onOpenCaseExport,
      }),
    })));

    const shareCase = container.find('button', 'Share Case');
    assert(shareCase, 'Missing Share Case button');
    await act(async () => click(shareCase));

    expect(onOpenCaseExport).toHaveBeenCalledOnce();
    expect(onOpenCaseExport).toHaveBeenCalledWith('run-shared');
  } finally {
    try {
      act(() => root.unmount());
    } finally {
      vi.unstubAllGlobals();
    }
  }
});

test('forwards the newly selected run id while the previous snapshot is still displayed', async () => {
  const onOpenCaseExport = vi.fn<(runId: string) => void>();
  const { container, click } = createPanelContainer();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', {
    HTMLIFrameElement: class HTMLIFrameElement {},
    localStorage: { getItem: () => 'en' },
  });
  const root = createRoot(container as unknown as HTMLElement);

  try {
    await act(async () => root.render(createElement(I18nProvider, {
      children: createElement(LiveRunPanel, {
        client: new BatonApiClient(),
        visible: true,
        liveSnapshot: shareCaseSnapshot,
        selectedRunId: 'run-selected',
        onSelectRunId: () => {},
        onToast: () => {},
        onOpenCaseExport,
      }),
    })));

    const shareCase = container.find('button', 'Share Case');
    assert(shareCase, 'Missing Share Case button');
    await act(async () => click(shareCase));

    expect(onOpenCaseExport).toHaveBeenCalledOnce();
    expect(onOpenCaseExport).toHaveBeenCalledWith('run-selected');
  } finally {
    try {
      act(() => root.unmount());
    } finally {
      vi.unstubAllGlobals();
    }
  }
});

test('disables approval and control actions and fires zero requests while switching runs', async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const client = new BatonApiClient('', fetchImpl);
  vi.spyOn(client, 'controlRun');
  vi.spyOn(client, 'resolveRun');
  const waitingSnapshot: LiveRunSnapshot = {
    run: { id: 'run-A', status: 'WAITING_HUMAN' },
    milestones: [],
    tasks: [],
    events: [],
    quotas: [],
  };
  const { container, click } = createPanelContainer();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', {
    HTMLIFrameElement: class HTMLIFrameElement {},
    localStorage: { getItem: () => 'en' },
  });
  const root = createRoot(container as unknown as HTMLElement);

  try {
    await act(async () => root.render(createElement(I18nProvider, {
      children: createElement(LiveRunPanel, {
        client,
        visible: true,
        liveSnapshot: waitingSnapshot,
        selectedRunId: 'run-B',
        runSynced: false,
        runSyncStatus: 'loading',
        onSelectRunId: () => {},
        onToast: () => {},
      }),
    })));

    expect(container.text).toContain('Loading selected run');
    const approveBtn = container.find('button', 'Approve') as unknown as { disabled?: boolean } | undefined;
    const rejectBtn = container.find('button', 'Reject') as unknown as { disabled?: boolean } | undefined;
    expect(approveBtn).toBeDefined();
    expect(rejectBtn).toBeDefined();
    if (approveBtn) await act(async () => click(approveBtn as never));
    if (rejectBtn) await act(async () => click(rejectBtn as never));
    expect(client.resolveRun).not.toHaveBeenCalled();
    expect(client.controlRun).not.toHaveBeenCalled();
  } finally {
    try {
      act(() => root.unmount());
    } finally {
      vi.unstubAllGlobals();
    }
  }
});

test('localizes GATE_CHECKING and COOLDOWN statuses in both EN and ZH without raw opencode text', () => {
  const snapshot: LiveRunSnapshot = {
    run: { id: 'run-1', status: 'RUNNING' },
    milestones: [],
    tasks: [
      { id: 'T1', title: 'Gate check', status: 'GATE_CHECKING' },
      { id: 'T2', title: 'Quota wait', status: 'COOLDOWN' },
    ],
    events: [],
    quotas: [],
  };
  const enPanel = renderToStaticMarkup(createElement(LiveRunPanel, {
    client: new BatonApiClient(),
    visible: true,
    liveSnapshot: snapshot,
    onSelectRunId: () => {},
    onToast: () => {},
  }));
  expect(enPanel).toContain('Gate Checking');
  expect(enPanel).toContain('Quota Cooldown');
  expect(enPanel).toContain('Running');
});
