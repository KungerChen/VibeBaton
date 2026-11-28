import { act, Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, assert, describe, expect, test, vi } from 'vitest';
import { ApiError, type GateReceipt, type RunArtifactResponse } from '../../api/client';
import { MESSAGES } from '../../i18n/messages';
import type { LiveRunSnapshot } from '../../types/graph';
import { BottomDock, DOCK_OPEN_KEY, DOCK_TAB_KEY, modelCalls, type BottomDockProps } from './BottomDock';

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) => isValidElement<Record<string, unknown>>(child)
    ? [child, ...elements(child.props.children as ReactNode)] : []);
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
  };
}

function useStorage(initial: Record<string, string> = {}) {
  const storage = memoryStorage(initial);
  vi.stubGlobal('window', { HTMLIFrameElement: class HTMLIFrameElement {}, localStorage: storage });
  return storage;
}

const copy = MESSAGES.en.guided.dock;
const relay = MESSAGES.en.guided.relay;

const snapshot: LiveRunSnapshot = {
  run: { id: 'run-abc123', status: 'RUNNING' },
  milestones: [], tasks: [], quotas: [],
  events: [
    { id: 1, kind: 'run_created', message: 'Run created in overnight mode', created_at: 100 },
    { id: 2, kind: 'role_invoked', actor: 'tactical_planner:sonnet', message: 'Invoking tactical_planner (claude_sub/sonnet)',
      payload_json: JSON.stringify({ artifact_key: 'plan_attempt_1' }), created_at: 101 },
    { id: 3, kind: 'role_invoked', actor: 'critical_executor:gpt-5@high', task_id: 'T1', milestone_id: 'M1',
      message: 'Invoking critical_executor (codex_sub/gpt-5@high)', payload: {}, created_at: 102 },
    { id: 4, kind: 'task_failed', task_id: 'T1', message: '测试失败', created_at: 103 },
  ],
};

function receipt(eventId: number, exitCode: number, extra: Partial<GateReceipt> = {}): GateReceipt {
  return { event_id: eventId, scope: 'task', target_id: 'T1', command: `npm test -- ${eventId}`, exit_code: exitCode,
    passed: exitCode === 0, duration_sec: 2.5, output_tail: `tail ${eventId}`, created_at: 100 + eventId, ...extra };
}

function props(extra: Partial<BottomDockProps> = {}): BottomDockProps {
  return { runId: 'run-abc123', snapshot, receipts: [], locale: 'en', loadArtifact: vi.fn(), ...extra };
}

function render(extra: Partial<BottomDockProps> = {}) {
  return renderToStaticMarkup(createElement(BottomDock, props(extra)));
}

afterEach(() => vi.unstubAllGlobals());

describe('collapsed dock', () => {
  test('is one line with the latest event and no tabs', () => {
    useStorage();
    const html = render();
    expect(html).toContain('data-dock-open="false"');
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="tabpanel"');
    const latest = /data-field="latest"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';
    expect(latest).toContain('Task Failed');
    expect(latest).toContain('T1');
    expect(latest).toContain('Original non-English note recorded');
    expect(latest).not.toContain('Run Created');
    expect(html).toContain(`aria-expanded="false"`);
    expect(html).toContain(copy.expand);
  });

  test('says there are no events yet, and shows the reconnect and loading states', () => {
    useStorage();
    const empty = render({ snapshot: { ...snapshot, events: [] } });
    expect(empty).toContain(copy.noEvents);
    expect(render({ reconnecting: true })).toContain(MESSAGES.en.inspector.reconnecting);
    expect(render({ syncStatus: 'loading' })).toContain(MESSAGES.en.inspector.runSyncing);
    expect(render({ syncStatus: 'error' })).toContain(MESSAGES.en.inspector.runSyncFailed);
    const synced = render({ syncStatus: 'synced' });
    expect(synced).not.toContain(MESSAGES.en.inspector.runSyncing);
    expect(synced).not.toContain(MESSAGES.en.inspector.reconnecting);
  });
});

describe('expanded dock', () => {
  test('offers Timeline, Terminal and Gates; the timeline says it covers the latest 200 events, oldest first', () => {
    useStorage({ [DOCK_OPEN_KEY]: 'open' });
    const html = render();
    expect(html).toContain('data-dock-open="true"');
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    for (const label of Object.values(copy.tabs)) expect(html).toContain(label);
    const tabTag = (tab: string) => new RegExp(`<button[^>]*role="tab"[^>]*data-tab="${tab}"[^>]*>`).exec(html)?.[0] ?? '';
    expect(tabTag('timeline')).toContain('aria-selected="true"');
    expect(tabTag('gates')).toContain('aria-selected="false"');
    expect(html).toContain(copy.timelineLimit(200));
    expect(copy.timelineLimit(200)).toBe('Shows the latest 200 events only');
    expect(MESSAGES.zh.guided.dock.timelineLimit(200)).toBe('只显示最近 200 条事件');
    const order = [...html.matchAll(/data-event-id="(\d+)"/g)].map((match) => match[1]);
    expect(order).toEqual(['1', '2', '3', '4']);
    expect(html).toContain(MESSAGES.en.inspector.originalNote);
    expect(html).toContain('测试失败');
    // Even an empty timeline says how far it reaches.
    expect(render({ snapshot: { ...snapshot, events: [] } })).toContain(copy.timelineLimit(200));
  });

  test('the gates tab lists every receipt newest first; only exit code 0 passes', () => {
    useStorage({ [DOCK_OPEN_KEY]: 'open', [DOCK_TAB_KEY]: 'gates' });
    const html = render({ receipts: [receipt(10, 0), receipt(11, 1, { passed: true, scope: 'milestone', target_id: 'M1' })] });
    expect(html).toContain(copy.gatesNote);
    const rows = [...html.matchAll(/<li data-field="receipt" data-passed="(true|false)"[\s\S]*?<\/li>/g)];
    expect(rows.map((row) => row[1])).toEqual(['false', 'true']);
    expect(rows[0][0]).toContain('npm test -- 11');
    expect(rows[0][0]).toContain(relay.handoff.receiptFailed);
    expect(rows[0][0]).not.toContain(relay.handoff.receiptPassed);
    expect(rows[0][0]).toContain(relay.handoff.exitCode(1));
    expect(rows[0][0]).toContain(relay.handoff.scopes.milestone);
    expect(rows[0][0]).toContain('M1');
    expect(rows[0][0]).toContain('2.5s');
    expect(rows[0][0]).toContain('tail 11');
    expect(rows[1][0]).toContain(relay.handoff.receiptPassed);
  });

  test('no receipts, or an older server without them, says so in a neutral colour and never says passed', () => {
    useStorage({ [DOCK_OPEN_KEY]: 'open', [DOCK_TAB_KEY]: 'gates' });
    for (const receipts of [[], null] as const) {
      const html = render({ receipts: receipts === null ? [] : receipts });
      expect(html).toContain(relay.handoff.noReceipts);
      expect(html).not.toContain(relay.handoff.receiptPassed);
      expect(html).not.toContain('data-passed');
    }
    expect(render({ receipts: null, receiptsFailed: true })).toContain(copy.gatesFailed);
  });

  test('the terminal tab lists each model call newest first and says what it covers', () => {
    useStorage({ [DOCK_OPEN_KEY]: 'open', [DOCK_TAB_KEY]: 'terminal' });
    expect(modelCalls(snapshot.events)).toEqual([
      { eventId: 3, artifactKey: null, role: 'critical_executor', model: 'gpt-5@high', scopeId: 'T1', at: 102 },
      { eventId: 2, artifactKey: 'plan_attempt_1', role: 'tactical_planner', model: 'sonnet', scopeId: null, at: 101 },
    ]);
    const html = render();
    expect(html).toContain(copy.terminalNote(200));
    const calls = [...html.matchAll(/data-call="(\d+)"/g)].map((match) => match[1]);
    expect(calls).toEqual(['3', '2']);
    expect(html).toContain('L2 Critical Executor');
    expect(html).toContain('gpt-5@high');
    expect(render({ snapshot: { ...snapshot, events: [snapshot.events[0]] } })).toContain(copy.noCalls);
  });
});

describe('dock interactions', () => {
  let root: Root | undefined;
  afterEach(() => { act(() => root?.unmount()); root = undefined; });

  async function mount(extra: Partial<BottomDockProps> = {}) {
    let view: ReactNode;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = { nodeType: 1, tagName: 'DIV', ownerDocument: null, addEventListener() {} };
    root = createRoot(container as unknown as HTMLElement);
    const dockProps = props(extra);
    function Probe() { view = BottomDock(dockProps); return null; }
    await act(async () => { root!.render(createElement(Probe)); });
    const find = (predicate: (node: ReactElement<Record<string, unknown>>) => boolean) => {
      const node = elements(view).find(predicate);
      assert(node, 'Expected a matching dock element');
      return node;
    };
    const click = async (node: ReactElement<Record<string, unknown>>) => {
      await act(async () => { (node.props.onClick as () => void)(); });
    };
    const text = () => renderToStaticMarkup(createElement('div', null, view));
    return { find, click, text, dockProps };
  }

  test('only the user\'s own expand and tab choice are stored; collapsed and Timeline by default', async () => {
    const storage = useStorage();
    const dock = await mount();
    expect(dock.find((node) => node.props.className === 'bottom-dock__toggle').props['aria-expanded']).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
    await dock.click(dock.find((node) => node.props.className === 'bottom-dock__toggle'));
    expect(storage.setItem).toHaveBeenCalledWith(DOCK_OPEN_KEY, 'open');
    expect(dock.find((node) => node.props['data-tab'] === 'timeline' && node.props.role === 'tab').props['aria-selected']).toBe(true);
    await dock.click(dock.find((node) => node.props['data-tab'] === 'gates' && node.props.role === 'tab'));
    expect(storage.setItem).toHaveBeenLastCalledWith(DOCK_TAB_KEY, 'gates');
    expect(storage.setItem).toHaveBeenCalledTimes(2);
    expect(dock.find((node) => node.props.role === 'tabpanel').props['data-tab']).toBe('gates');
    await dock.click(dock.find((node) => node.props.className === 'bottom-dock__toggle'));
    expect(storage.values.get(DOCK_OPEN_KEY)).toBe('closed');
  });

  test('a call without an artifact key, a 404 and a missing part all read "Not recorded"; a cut text says so', async () => {
    useStorage({ [DOCK_OPEN_KEY]: 'open', [DOCK_TAB_KEY]: 'terminal' });
    const artifact: RunArtifactResponse = { run_id: 'run-abc123', artifact_key: 'plan_attempt_1',
      prompt: null, output: { text: 'The plan output', truncated: true, bytes: 900000 } };
    const missing = vi.fn<(key: string) => Promise<RunArtifactResponse>>().mockRejectedValue(new ApiError(404, 'not found'));
    let dock = await mount({ loadArtifact: missing });
    const call = (id: number) => dock.find((node) => node.props['data-call'] === id);

    await dock.click(call(3));
    expect(missing).not.toHaveBeenCalled();
    expect(dock.text()).toContain(relay.notRecorded);

    await dock.click(call(2));
    expect(missing).toHaveBeenCalledWith('plan_attempt_1');
    expect(dock.text()).toContain(relay.notRecorded);
    expect(dock.text()).not.toContain('not found');
    act(() => root!.unmount());

    const found = vi.fn<(key: string) => Promise<RunArtifactResponse>>().mockResolvedValue(artifact);
    dock = await mount({ loadArtifact: found });
    await dock.click(call(2));
    expect(found).toHaveBeenCalledWith('plan_attempt_1');
    const html = dock.text();
    expect(html).toContain('The plan output');
    expect(html).toContain(relay.handoff.truncated);
    expect(html).toContain(copy.output);
    expect(html).toContain(copy.prompt);
    // The prompt was not saved for this call.
    expect(html).toContain(relay.notRecorded);
  });
});
