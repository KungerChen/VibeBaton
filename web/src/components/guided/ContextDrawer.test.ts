import { act, Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, assert, describe, expect, test, vi } from 'vitest';
import { buildLiveRunGraph } from '../../engine/liveRunGraph';
import { MESSAGES } from '../../i18n/messages';
import type { LiveRunSnapshot } from '../../types/graph';
import {
  DrawerDetails, DrawerPanel, drawerDetailsKey, readDrawerDetails, RelayNodePanel, RunOverviewPanel, writeDrawerDetails,
  type DrawerOwner,
} from './ContextDrawer';
import { drawerOwner } from './GuidedWorkbench';

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

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('drawer owner', () => {
  test('a pending decision owns the drawer even while something is selected', () => {
    expect(drawerOwner(true, null)).toBe('decision');
    expect(drawerOwner(true, { kind: 'node', id: 'live-task-T1' })).toBe('decision');
    expect(drawerOwner(true, { kind: 'node', id: 'live-planner' })).toBe('decision');
    expect(drawerOwner(true, { kind: 'edge', id: 'live-edge-live-planner-to-live-task-T1' })).toBe('decision');
  });

  test('without a decision the selection owns it, and with nothing selected the run overview does', () => {
    expect(drawerOwner(false, { kind: 'node', id: 'live-task-T1' })).toBe('task');
    for (const id of ['live-planner', 'live-ms-M1', 'live-final-gate', 'live-panel-synthesizer']) {
      expect(drawerOwner(false, { kind: 'node', id }), id).toBe('node');
    }
    expect(drawerOwner(false, { kind: 'edge', id: 'live-edge-live-planner-to-live-task-T1' })).toBe('handoff');
    expect(drawerOwner(false, null)).toBe('overview');
  });

  test('a panel that is not the owner stays mounted but hidden', () => {
    const shown = renderToStaticMarkup(createElement(DrawerPanel, { panel: 'task', owner: 'task' }, 'Task body'));
    const hidden = renderToStaticMarkup(createElement(DrawerPanel, { panel: 'task', owner: 'decision' }, 'Task body'));
    expect(shown).toContain('data-panel="task"');
    expect(shown).not.toContain('hidden');
    expect(hidden).toContain('hidden=""');
    expect(hidden).toContain('Task body');
  });
});

describe('remembered technical details', () => {
  test('one key per panel type, collapsed by default and when storage fails', () => {
    expect(drawerDetailsKey('task')).toBe('vibebaton.drawerDetails.task');
    const storage = memoryStorage();
    expect(readDrawerDetails(storage, 'task')).toBe(false);
    expect(readDrawerDetails(null, 'task')).toBe(false);
    writeDrawerDetails(storage, 'task', true);
    expect(storage.values.get('vibebaton.drawerDetails.task')).toBe('open');
    expect(readDrawerDetails(storage, 'task')).toBe(true);
    expect(readDrawerDetails(storage, 'handoff')).toBe(false);
    writeDrawerDetails(storage, 'task', false);
    expect(readDrawerDetails(storage, 'task')).toBe(false);
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readDrawerDetails(broken, 'task')).toBe(false);
    expect(() => writeDrawerDetails(broken, 'task', true)).not.toThrow();
  });

  async function mountDetails(panel: DrawerOwner) {
    let view: ReactNode;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = { nodeType: 1, tagName: 'DIV', ownerDocument: null, addEventListener() {} };
    root = createRoot(container as unknown as HTMLElement);
    function Probe() { view = DrawerDetails({ panel, locale: 'en', children: 'Model: sonnet' }); return null; }
    await act(async () => { root!.render(createElement(Probe)); });
    const toggle = () => {
      const button = elements(view).find((node) => node.type === 'button');
      assert(button);
      return button;
    };
    return { toggle, click: async () => { await act(async () => { (toggle().props.onClick as () => void)(); }); } };
  }

  test('only the user\'s own click is stored, and the next panel of that type opens expanded', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('window', { HTMLIFrameElement: class HTMLIFrameElement {}, localStorage:storage });
    const first = await mountDetails('task');
    expect(first.toggle().props['aria-expanded']).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
    await first.click();
    expect(first.toggle().props['aria-expanded']).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith('vibebaton.drawerDetails.task', 'open');
    act(() => root!.unmount());

    const again = await mountDetails('task');
    expect(again.toggle().props['aria-expanded']).toBe(true);
    act(() => root!.unmount());
    const other = await mountDetails('handoff');
    expect(other.toggle().props['aria-expanded']).toBe(false);
    expect(storage.setItem).toHaveBeenCalledOnce();

    await other.click();
    await other.click();
    expect(storage.values.get('vibebaton.drawerDetails.handoff')).toBe('closed');
    expect(storage.values.get('vibebaton.drawerDetails.task')).toBe('open');
  });

  test('a collapsed section keeps its content in the page but hidden', () => {
    vi.stubGlobal('window', { HTMLIFrameElement: class HTMLIFrameElement {}, localStorage:memoryStorage() });
    const closed = renderToStaticMarkup(createElement(DrawerDetails, { panel: 'node', locale: 'en' }, 'Model: sonnet'));
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain('hidden=""');
    expect(closed).toContain(MESSAGES.en.guided.relay.details);
    vi.stubGlobal('window', { HTMLIFrameElement: class HTMLIFrameElement {}, localStorage:memoryStorage({ 'vibebaton.drawerDetails.node': 'open' }) });
    const open = renderToStaticMarkup(createElement(DrawerDetails, { panel: 'node', locale: 'zh' }, 'Model: sonnet'));
    expect(open).toContain('aria-expanded="true"');
    expect(open).not.toContain('hidden=""');
    expect(open).toContain(MESSAGES.zh.guided.relay.details);
  });
});

describe('node and overview panels', () => {
  const snapshot: LiveRunSnapshot = {
    run: { id: 'r1', status: 'RUNNING' },
    milestones: [{ id: 'M1', title: 'Core', status: 'PENDING' }],
    tasks: [{ id: 'T1', milestone_id: 'M1', title: 'Write', status: 'PASSED' }, { id: 'T2', milestone_id: 'M1', title: 'Test', status: 'RUNNING' }],
    events: [{ id: 3, kind: 'role_invoked', message: 'Invoking tactical_planner (claude_sub/sonnet)' }],
    quotas: [],
    telemetry: { elapsed_sec: 5, server_now: 10, models: [], stages: [{ id: 'PLANNING', kind: 'planning', title: 'Plan',
      status: 'PASSED', wall_sec: 90, task_sum_sec: 0, passed_tasks: 0, total_tasks: 0, started_at: null, is_active: false }] },
  };
  const view = buildLiveRunGraph(snapshot, 'en');
  const node = (id: string) => {
    const found = view.graph.nodes.find((item) => item.id === id);
    assert(found);
    return found;
  };

  test('a node panel says who the step is and how it is doing; the model and time sit in the details', () => {
    vi.stubGlobal('window', { HTMLIFrameElement: class HTMLIFrameElement {}, localStorage:memoryStorage() });
    const copy = MESSAGES.en.guided.relay;
    const planner = renderToStaticMarkup(createElement(RelayNodePanel, { node: node('live-planner'), state: 'passed', locale: 'en' }));
    expect(planner).toContain(node('live-planner').label);
    expect(planner).toContain(copy.node.kinds.planner_node);
    expect(planner).toContain(copy.node.states.passed);
    expect(planner).toContain('L1 Tactical Planner');
    expect(planner).toContain('Claude Code / sonnet');
    expect(planner).toContain('1m 30s');
    const gate = renderToStaticMarkup(createElement(RelayNodePanel, { node: node('live-final-gate'), state: 'idle', locale: 'zh' }));
    expect(gate).toContain(MESSAGES.zh.guided.relay.node.kinds.human_gate_node);
    expect(gate).toContain(MESSAGES.zh.guided.relay.node.states.idle);
    // No timing was reported for the gate.
    expect(gate).toContain(`<dd data-field="elapsed">${MESSAGES.zh.guided.relay.unknown}</dd>`);
  });

  test('the overview says how the run is doing, how many tasks are done and who works now', () => {
    vi.stubGlobal('window', { HTMLIFrameElement: class HTMLIFrameElement {}, localStorage:memoryStorage() });
    const copy = MESSAGES.en.guided.relay.overview;
    const html = renderToStaticMarkup(createElement(RunOverviewPanel, { snapshot, view, locale: 'en' }));
    expect(html).toContain(copy.statuses.RUNNING);
    expect(html).toContain(copy.tasksDone(1, 2));
    expect(html).toContain(copy.holder(node('live-task-T2').label));
    expect(html).toContain('r1');

    const idle = { ...snapshot, run: { id: 'r1', status: 'PAUSED' }, tasks: [{ id: 'T1', milestone_id: 'M1', status: 'PASSED' }],
      milestones: [{ id: 'M1', status: 'PASSED' }] };
    const zh = renderToStaticMarkup(createElement(RunOverviewPanel, { snapshot: idle, view: buildLiveRunGraph(idle, 'zh'), locale: 'zh' }));
    expect(zh).toContain(MESSAGES.zh.guided.relay.overview.statuses.PAUSED);
    expect(zh).toContain(MESSAGES.zh.guided.relay.overview.tasksDone(1, 1));
    expect(zh).toContain(MESSAGES.zh.guided.relay.overview.noHolder);
  });
});
