import { act, Children, createElement, isValidElement, useCallback, useState, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, assert, describe, expect, test, vi } from 'vitest';
import { ApiError, type BatonApiClient, type BrainstormTurnResult, type GuidedSession, type GuidedSessionPatch } from '../../api/client';
import type { LiveRunSnapshot } from '../../types/graph';
import { GuidedBrainstormStep } from './GuidedBrainstormStep';
import { GuidedSetupStep } from './GuidedSetupStep';
import { GuidedSignOffPanel } from './GuidedSignOffPanel';
import type { GuidedSessionState } from './useGuidedSession';
import { GuidedWorkbench, startReplannedRevision, useGuidedWorkbenchView } from './GuidedWorkbench';

vi.mock('../CanvasWorkspace', () => ({ CanvasWorkspace: () => createElement('div', { 'data-testid': 'live-canvas' }) }));
vi.mock('./GuidedSetupStep', async (load) => {
  const actual = await load<typeof import('./GuidedSetupStep')>();
  return { ...actual, GuidedSetupStep: (props: { onReady: (value: typeof lineup) => void }) =>
    createElement('button', { onClick: () => props.onReady(lineup) }, 'Use team') };
});

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) => isValidElement<Record<string, unknown>>(child)
    ? [child, ...elements(child.props.children as ReactNode)] : []);
}

const lineup = { ready: true, roles: { brainstorm_and_final_gate: 'codex' }, model_overrides: {},
  source: 'cli' as const, notes_en: '', notes_zh: '' };

function session(stage: GuidedSession['active_stage']): GuidedSession {
  return { schema_version: 1, active_stage: stage, workspace_path: '/repo',
    brainstorm: { messages: [], checklist: [], latest_rfc_draft: '# Blueprint', selected_l0_model: null, has_online_draft: true },
    workflow: { mode: 'overnight', lineup: { roles: lineup.roles, model_overrides: {} }, preset: null,
      panel_enabled: false, launch_request_id: null, guided_selected_lineup: JSON.stringify(lineup),
      guided_selected_run_id: stage === 'signoff' ? 'run-a' : null },
    active_run_id: stage === 'signoff' ? 'run-a' : null, open_human_gate: null, open_drawer: null };
}

describe('Guided loop integration', () => {
  let root: Root | undefined;
  let view: ReactNode;

  async function mount(saved: GuidedSession, snapshot: LiveRunSnapshot | null = null) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { HTMLIFrameElement: class HTMLIFrameElement {} });
    const client = {
      getGuidedSession: vi.fn(async () => structuredClone(saved)),
      saveGuidedSession: vi.fn(async () => structuredClone(saved)),
      resetGuidedSession: vi.fn(), getWorkspaceInfo: vi.fn(async () => ({ path: '/repo' })),
    } as unknown as BatonApiClient;
    const onFollowRun = vi.fn();
    const container = { nodeType: 1, tagName: 'DIV', ownerDocument: null, addEventListener() {} };
    root = createRoot(container as unknown as HTMLElement);
    function Probe() { view = useGuidedWorkbenchView({ locale: 'en', client, apiMode: 'local', liveSnapshot: snapshot, onFollowRun }); return null; }
    await act(async () => { root!.render(createElement(Probe)); });
    return { client, onFollowRun };
  }

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('restored blueprint shares the workspace client and the session owner', async () => {
    const { client } = await mount(session('blueprint'));
    const brainstorm = elements(view).find((node) => node.type === GuidedBrainstormStep);
    assert(brainstorm);
    expect(brainstorm.props.services).toBe(client);
    expect(brainstorm.props.guidedSession).toMatchObject({ session: expect.objectContaining({ workspace_path: '/repo' }) });
  });

  test('restored sign-off receives revision and rollback routes from the host', async () => {
    await mount(session('signoff'), { run: { id: 'run-a', status: 'READY_FOR_FINAL_GATE' }, milestones: [], tasks: [], events: [], quotas: [] });
    const panel = elements(view).find((node) => node.type === GuidedSignOffPanel);
    assert(panel);
    expect(panel.props.priorRfc).toBe('# Blueprint');
    expect(panel.props.onRequestRevision).toEqual(expect.any(Function));
    expect(panel.props.rollbacker).toEqual(expect.any(Function));
  });

  test('switching workspaces restores the newly selected workspace session', async () => {
    const saved = session('setup');
    const { client } = await mount(saved);
    const setup = elements(view).find((node) => node.type === GuidedSetupStep);
    assert(setup);
    const owner = setup.props.guidedSession as GuidedSessionState;
    const selected = blueprintSession(); selected.workspace_path = '/other';
    Object.assign(saved, selected);
    vi.mocked(client.getWorkspaceInfo).mockResolvedValue({ path: '/other', is_git_repo: true, has_commits: true,
      branch: 'main', has_rfc: true });
    await act(async () => {
      owner.save({ workspace_path: '/other' });
      await owner.flush();
    });
    await act(async () => {
      (setup.props.onWorkspaceChanged as (info: { path: string }) => void)({ path: '/other' });
    });
    const restored = elements(view).find((node) => node.type === GuidedBrainstormStep);
    assert(restored);
    expect(restored.props.projectPath).toBe('/other');
  });
});

// A small React host lets these tests mount the real workbench and its steps in
// Vitest's Node environment. Only the graph renderer and host scan are stubbed.
class TestNode {
  childNodes: TestNode[] = [];
  parentNode: TestNode | null = null;
  nodeValue: string | null = null;
  constructor(public nodeType: number, public nodeName: string, public ownerDocument: TestDocument) {}
  appendChild(node: TestNode) { node.parentNode?.removeChild(node); this.childNodes.push(node); node.parentNode = this; return node; }
  removeChild(node: TestNode) { this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null; return node; }
  insertBefore(node: TestNode, before: TestNode) {
    node.parentNode?.removeChild(node); this.childNodes.splice(this.childNodes.indexOf(before), 0, node); node.parentNode = this; return node;
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get textContent(): string { return this.nodeValue ?? this.childNodes.map((child) => child.textContent).join(''); }
  set textContent(value: string) {
    this.childNodes = []; this.nodeValue = this.nodeType === 3 ? value : null;
    if (this.nodeType !== 3 && value) this.appendChild(this.ownerDocument.createTextNode(value));
  }
  addEventListener() {}
  removeEventListener() {}
}
class TestElement extends TestNode {
  tagName: string;
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  value = ''; checked = false; selected = false; disabled = false; multiple = false;
  constructor(tag: string, document: TestDocument) { super(1, tag.toUpperCase(), document); this.tagName = this.nodeName; }
  setAttribute(name: string, value: string) { this.attributes[name] = String(value); }
  removeAttribute(name: string) { delete this.attributes[name]; }
  setAttributeNS(_namespace: string, name: string, value: string) { this.setAttribute(name, value); }
  get options(): TestElement[] { return this.childNodes.flatMap((child) => child instanceof TestElement
    ? child.tagName === 'OPTION' ? [child] : child.options : []); }
  focus() { this.ownerDocument.activeElement = this; }
}
class TestDocument {
  nodeType = 9;
  documentElement = new TestElement('html', this);
  body = new TestElement('body', this);
  activeElement: TestElement | null = this.body;
  createElement(tag: string) { return new TestElement(tag, this); }
  createElementNS(_namespace: string, tag: string) { return this.createElement(tag); }
  createTextNode(value: string) { const node = new TestNode(3, '#text', this); node.nodeValue = value; return node; }
  addEventListener() {}
  removeEventListener() {}
}
function propsOf(node: TestNode): Record<string, unknown> {
  const key = Object.keys(node).find((name) => name.startsWith('__reactProps$'));
  return key ? (node as unknown as Record<string, Record<string, unknown>>)[key] : {};
}
function findNode(node: TestNode, predicate: (node: TestNode, props: Record<string, unknown>) => boolean): TestNode | undefined {
  if (predicate(node, propsOf(node))) return node;
  for (const child of node.childNodes) { const found = findNode(child, predicate); if (found) return found; }
  return undefined;
}
function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const output = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const previous = output[key];
    output[key] = value && typeof value === 'object' && !Array.isArray(value)
      && previous && typeof previous === 'object' && !Array.isArray(previous)
      ? merge(previous as Record<string, unknown>, value as Record<string, unknown>) : value;
  }
  return output;
}
const shaA = 'a'.repeat(40), shaB = 'b'.repeat(40), shaC = 'c'.repeat(40);
const recommendation = { mode: 'overnight' as const, preset: null, size: 'medium' as const,
  lineup: { roles: lineup.roles, model_overrides: {}, size: 'medium' as const },
  reason_code: 'medium_relay', explanation_key: 'workflow.medium_relay', fallback: false,
  size_changed: null, explanation_codes: ['medium_relay'], substitutions: [] };
const pastedReadiness = { score: 100, safe_for_overnight: true, missing_sections: [], warnings: [], detected_commands: ['npm test'] };
function turn(draft: string): BrainstormTurnResult {
  return { reply: 'Blueprint ready', rfc_markdown: draft, provider_used: 'codex', offline: false, error: null,
    blueprint: { title: 'Project', summary: 'Summary', deliverables: [], touched_areas: [], verification_plan: [],
      readiness_score: 100, ready_to_launch: true },
    guide: { question: '', options: [], checklist: [] }, recommendation };
}
function blueprintSession(): GuidedSession {
  const saved = session('blueprint');
  saved.brainstorm.messages = [{ role: 'user', content: 'Build it' }, { role: 'assistant', content: 'Blueprint ready' }];
  saved.brainstorm.guided_turn_snapshot = JSON.stringify(turn(saved.brainstorm.latest_rfc_draft));
  saved.workflow.lineup = recommendation.lineup;
  return saved;
}
function snap(run: Record<string, unknown> | null, tasks: Record<string, unknown>[] = []): LiveRunSnapshot {
  return { run, tasks, milestones: [], events: [], quotas: [] };
}

function fakeServer(initial: GuidedSession) {
  let saved = structuredClone(initial);
  const runs = new Map<string, LiveRunSnapshot>();
  const launchedKeys = new Map<string, string>();
  let childNumber = 1;
  let releaseStart: (() => void) | null = null;
  const client = {
    getGuidedSession: vi.fn(async () => structuredClone(saved)),
    saveGuidedSession: vi.fn(async (patch: GuidedSessionPatch) => {
      saved = merge(saved, patch as Record<string, unknown>) as unknown as GuidedSession;
      return structuredClone(saved);
    }),
    resetGuidedSession: vi.fn(async () => {
      saved = session('setup'); saved.brainstorm.latest_rfc_draft = ''; saved.brainstorm.messages = [];
      saved.workflow.lineup = { roles: {}, model_overrides: {} }; saved.workflow.guided_selected_lineup = null;
      return structuredClone(saved);
    }),
    getWorkspaceInfo: vi.fn(async () => ({ path: '/repo', is_git_repo: true, has_commits: true })),
    getL0Models: vi.fn(async () => ({ models: [], auto_selected: null })),
    getModelCatalog: vi.fn(async () => { throw new Error('use built-in catalog'); }),
    getLineupProfiles: vi.fn(async () => ({ profiles: [], last_used: null })),
    saveLastUsedLineup: vi.fn(async () => ({ profiles: [], last_used: null })),
    saveLineupProfile: vi.fn(), deleteLineupProfile: vi.fn(),
    getRolesConfig: vi.fn(async () => ({ budget_profile: 'balanced' })),
    checkRfc: vi.fn(async () => pastedReadiness),
    recommendBlueprint: vi.fn(async () => ({ recommendation: { ...recommendation, flow: 'full', flow_reason: 'size_not_small' },
      readiness: pastedReadiness })),
    brainstormChat: vi.fn(async (payload: { messages: { role: string; content: string }[] }) => {
      const result = turn('# Revised blueprint');
      saved.brainstorm = { ...saved.brainstorm, messages: [...payload.messages, { role: 'assistant', content: result.reply }] as GuidedSession['brainstorm']['messages'],
        checklist: result.guide.checklist, latest_rfc_draft: result.rfc_markdown, has_online_draft: true };
      return result;
    }),
    startRun: vi.fn(async (payload: { launch_request_id: string }) => {
      let id = launchedKeys.get(payload.launch_request_id);
      if (!id) {
        id = 'run-1'; launchedKeys.set(payload.launch_request_id, id);
        runs.set(id, snap({ id, status: 'RUNNING', parent_run_id: null, base_ref: 'main', start_sha: shaA, result_sha: shaB }));
        saved = { ...saved, active_stage: 'build', active_run_id: id };
      }
      await new Promise<void>((resolve) => { releaseStart = resolve; });
      return { run_id: id, daemon_pid: 1, status: 'STARTED' };
    }),
    getRun: vi.fn(async (id: string) => structuredClone(runs.get(id) ?? snap(null))),
    getLineageRun: vi.fn(async (id: string) => structuredClone(runs.get(id) ?? snap(null))),
    listLineageRuns: vi.fn(async () => [...runs.values()].map(({ run }) => run)),
    getLatestRun: vi.fn(async () => structuredClone([...runs.values()].at(-1) ?? snap(null))),
    stopAndReplan: vi.fn(async (id: string) => {
      const current = runs.get(id)!;
      current.run!.status = 'SUPERSEDED';
      saved = { ...saved, active_stage: 'blueprint', active_run_id: id };
      return { ok: true as const, status: 'SUPERSEDED' as const, run_id: id, failed_tasks: [],
        last_errors: { T1: 'failed check' }, current_sha: String(current.run!.result_sha), run_summary: 'Failed' };
    }),
    requestChanges: vi.fn(async (id: string, _note: string) => {
      const parent = runs.get(id)!; const child = `run-${++childNumber}`;
      runs.set(child, snap({ id: child, status: 'RUNNING', parent_run_id: id, base_ref: 'main',
        start_sha: parent.run!.result_sha, result_sha: shaC }));
      saved = { ...saved, active_stage: 'build', active_run_id: child };
      return { ok: true, run_id: id, status: 'SUPERSEDED', revision_run_id: child };
    }),
    rollbackRun: vi.fn(async (id: string, mode: 'revert_revision' | 'abandon_all' | 'undo') => {
      const target = mode === 'revert_revision' ? shaB : shaA;
      const current = runs.get(id)!; current.run!.status = 'PAUSED'; current.run!.result_sha = target;
      saved = { ...saved, active_stage: 'signoff', active_run_id: id };
      return { ok: true as const, run_id: id, status: 'PAUSED' as const, mode, restored_to: target, base_branch: 'main', base_head: shaA };
    }),
    finalizeRun: vi.fn(async (id: string) => {
      const current = runs.get(id)!; current.run!.status = 'COMPLETED';
      current.events.push({ kind: 'final_gate_approved', payload: { merged_commit: shaC, pre_merge_head: shaA } });
      saved = { ...saved, active_stage: 'signoff', active_run_id: id };
      return { ok: true as const, run_id: id, action: 'approve' as const, status: 'COMPLETED', backup_tag: null,
        base_branch: 'main', base_head: shaC, merged_commit: shaC, changed_files: [] };
    }),
    resolveRunTask: vi.fn(async (id: string) => { runs.get(id)!.run!.status = 'RUNNING'; return {}; }),
  };
  return { client: client as unknown as BatonApiClient, calls: client, runs,
    saved: () => structuredClone(saved), setSaved: (next: GuidedSession) => { saved = structuredClone(next); },
    release: () => { assert(releaseStart); releaseStart(); } };
}

describe('mounted four-stage loop', () => {
  let root: Root | undefined;
  let container: TestElement;
  let server: ReturnType<typeof fakeServer>;

  async function mount() {
    const document = new TestDocument();
    const storage = new Map<string, string>();
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', { document, HTMLIFrameElement: class {}, matchMedia: () => ({ matches: true }),
      localStorage: { getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('crypto', { randomUUID: () => 'launch-key' });
    container = document.createElement('div');
    root = createRoot(container as unknown as HTMLElement);
    function Host() {
      const [snapshot, setSnapshot] = useState<LiveRunSnapshot | null>(null);
      const follow = useCallback((id: string) => { void server.client.getRun(id).then(setSnapshot); }, []);
      return createElement(GuidedWorkbench, { locale: 'en', apiMode: 'local', client: server.client, liveSnapshot: snapshot, onFollowRun: follow });
    }
    await act(async () => { root!.render(createElement(Host)); });
  }
  async function unmount() { await act(async () => { root?.unmount(); }); root = undefined; }
  function byClass(name: string) {
    const node = findNode(container, (_node, props) => typeof props.className === 'string' && props.className.split(' ').includes(name));
    assert(node, `Expected .${name}`); return node;
  }
  function button(text: string) {
    const node = findNode(container, (item) => item.nodeName === 'BUTTON' && item.textContent.trim() === text);
    assert(node, `Expected button ${text}; got ${container.textContent}`); return node;
  }
  async function click(node: TestNode) {
    expect(propsOf(node).disabled).not.toBe(true);
    await act(async () => { (propsOf(node).onClick as () => void)(); });
  }
  /** Starting a build is two clicks: the start button, then the confirmation. */
  async function launchAndConfirm() {
    await click(byClass('guided-launch-bar__launch'));
    await click(byClass('guided-launch-bar__confirm-start'));
  }
  async function submitRevision(text: string) {
    const input = byClass('guided-brainstorm__input');
    await act(async () => { (propsOf(input).onChange as (event: unknown) => void)({ target: { value: text }, currentTarget: { value: text } }); });
    await act(async () => { (propsOf(byClass('guided-brainstorm__composer')).onSubmit as (event: unknown) => void)({ preventDefault() {} }); });
  }
  afterEach(async () => { if (root) await unmount(); vi.unstubAllGlobals(); });

  test('restores each stage and the active human-gate drawer from the session', async () => {
    for (const stage of ['setup', 'blueprint', 'build', 'signoff'] as const) {
      const saved = stage === 'setup' ? session('setup') : blueprintSession();
      saved.active_stage = stage;
      if (stage === 'blueprint') { saved.workflow.mode = 'panel'; saved.brainstorm.guided_input = 'Saved question'; }
      if (stage === 'build' || stage === 'signoff') saved.active_run_id = 'run-1';
      if (stage === 'build') saved.open_human_gate = { run_id: 'run-1', task_id: 'T1' };
      server = fakeServer(saved);
      server.runs.set('run-1', snap({ id: 'run-1', status: stage === 'signoff' ? 'READY_FOR_FINAL_GATE' : 'WAITING_HUMAN',
        human_prompt: 'Approve?', parent_run_id: null, base_ref: 'main', start_sha: shaA, result_sha: shaB },
      stage === 'build' ? [{ id: 'T1', status: 'WAITING_HUMAN' }] : []));
      await mount();
      const expected = stage === 'blueprint' ? 'brainstorm' : stage === 'build' ? 'live' : stage;
      expect(propsOf(byClass('guided-workbench__body'))['data-step']).toBe(expected);
      if (stage === 'blueprint') {
        expect(container.textContent).toContain('Blueprint ready');
        expect(propsOf(byClass('guided-brainstorm__input')).value).toBe('Saved question');
        const panel = findNode(byClass('guided-launch-bar__panel'), (node) => node.nodeName === 'INPUT');
        assert(panel); expect(propsOf(panel).checked).toBe(true);
        await click(byClass('guided-brainstorm__rfc-toggle'));
        expect(container.textContent).toContain('Blueprint');
      }
      if (stage === 'build') { expect(byClass('guided-decision-drawer')).toBeTruthy(); expect(container.textContent).toContain('Approve?'); }
      if (stage === 'signoff') expect(byClass('guided-sign-off')).toBeTruthy();
      await unmount();
    }
  });

  test('duplicate launch and a refresh during its response restore the one active run', async () => {
    server = fakeServer(blueprintSession());
    await mount();
    const launch = byClass('guided-launch-bar__launch');
    expect(propsOf(launch).disabled).toBe(false);
    await click(launch);
    expect(server.calls.startRun).not.toHaveBeenCalled();
    await act(async () => {
      const onClick = propsOf(byClass('guided-launch-bar__confirm-start')).onClick as () => void; onClick(); onClick();
    });
    expect(server.calls.startRun).toHaveBeenCalledOnce();
    expect(server.saved().active_run_id).toBe('run-1');
    await unmount();
    await mount();
    expect(propsOf(byClass('guided-workbench__body'))['data-step']).toBe('live');
    expect(findNode(container, (_node, props) => props['data-testid'] === 'live-canvas')).toBeTruthy();
    await act(async () => { server.release(); });
    expect(server.calls.startRun).toHaveBeenCalledOnce();
  });

  test('refresh before launch completes replays the saved key and converges on one run', async () => {
    server = fakeServer(blueprintSession());
    let finishFirst!: (result: { run_id: string; daemon_pid: number; status: string }) => void;
    server.calls.startRun.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
    server.calls.startRun.mockImplementationOnce(async () => {
      server.runs.set('run-1', snap({ id: 'run-1', status: 'RUNNING', parent_run_id: null,
        base_ref: 'main', start_sha: shaA, result_sha: shaB }));
      const latest = server.saved(); latest.active_stage = 'build'; latest.active_run_id = 'run-1';
      server.setSaved(latest);
      return { run_id: 'run-1', daemon_pid: 1, status: 'STARTED' };
    });
    await mount(); await launchAndConfirm();
    expect(server.saved().active_run_id).toBeNull();
    expect(server.saved().workflow.guided_pending_launch).toBeTruthy();
    await unmount(); await mount();
    await launchAndConfirm();
    const keys = server.calls.startRun.mock.calls.map(([payload]) => payload.launch_request_id);
    expect(keys).toEqual(['launch-key', 'launch-key']);
    expect(server.runs.size).toBe(1);
    expect(propsOf(byClass('guided-workbench__body'))['data-step']).toBe('live');
    await act(async () => { finishFirst({ run_id: 'run-1', daemon_pid: 1, status: 'STARTED' }); });
  });

  test('a pasted RFC survives an unanswered start and a refresh, and the retry sends the saved request once more', async () => {
    const pasted = '# Health endpoint\n\n## Goals\n- Add a health endpoint.\n';
    const wait = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
    server = fakeServer(session('blueprint'));
    let finishFirst!: (result: { run_id: string; daemon_pid: number; status: string }) => void;
    server.calls.startRun.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
    server.calls.startRun.mockImplementationOnce(async () => {
      server.runs.set('run-1', snap({ id: 'run-1', status: 'RUNNING', parent_run_id: null,
        base_ref: 'main', start_sha: shaA, result_sha: shaB }));
      const latest = server.saved(); latest.active_stage = 'build'; latest.active_run_id = 'run-1';
      server.setSaved(latest);
      return { run_id: 'run-1', daemon_pid: 1, status: 'STARTED' };
    });
    await mount();
    await act(async () => {
      (propsOf(byClass('rfc-step__markdown')).onChange as (event: unknown) => void)({ currentTarget: { value: pasted } });
    });
    await wait();
    expect(server.calls.recommendBlueprint).toHaveBeenCalledWith(pasted);
    await launchAndConfirm();
    expect(server.saved().workflow.guided_pending_launch).toBeTruthy();
    expect(server.saved().active_run_id).toBeNull();

    await unmount(); await mount();
    await wait();
    expect(propsOf(byClass('rfc-step__markdown')).value).toBe(pasted);
    expect(propsOf(byClass('rfc-step__markdown')).readOnly).toBe(true);
    await click(byClass('guided-launch-bar__launch'));
    expect(container.textContent).toContain('Health endpoint');
    await click(byClass('guided-launch-bar__confirm-start'));
    const payloads = server.calls.startRun.mock.calls.map(([payload]) => payload);
    expect(payloads.map((payload) => payload.launch_request_id)).toEqual(['launch-key', 'launch-key']);
    expect(payloads[1]).toEqual(payloads[0]);
    expect(payloads[0]).toMatchObject({ rfc_markdown: pasted, mode: 'overnight' });
    expect(server.runs.size).toBe(1);
    expect(propsOf(byClass('guided-workbench__body'))['data-step']).toBe('live');
    await act(async () => { finishFirst({ run_id: 'run-1', daemon_pid: 1, status: 'STARTED' }); });
  });

  test('FAILED returns to Blueprint and starts a child using the revised draft', async () => {
    const saved = blueprintSession(); saved.active_stage = 'build'; saved.active_run_id = 'run-1';
    saved.workflow.guided_pending_launch = JSON.stringify({ launch_request_id: 'old-key', rfc_markdown: '# Blueprint',
      mode: 'overnight', lineup: recommendation.lineup, preset: null });
    saved.workflow.launch_request_id = 'old-key';
    server = fakeServer(saved);
    server.runs.set('run-1', snap({ id: 'run-1', status: 'FAILED', parent_run_id: null,
      base_ref: 'main', start_sha: shaA, result_sha: shaB }));
    await mount();
    await click(button('Stop & Replan'));
    const confirm = findNode(container, (_node, props) => props.role === 'group' && props['aria-label'] === 'Stop & Replan');
    assert(confirm); const confirmButton = findNode(confirm, (node) => node.nodeName === 'BUTTON' && node.textContent === 'Stop & Replan');
    assert(confirmButton); await click(confirmButton);
    expect(propsOf(byClass('guided-workbench__body'))['data-step']).toBe('brainstorm');
    expect(container.textContent).toContain('failed check');
    expect(server.saved().workflow.guided_pending_launch).toBeNull();
    await submitRevision('Fix tests');
    expect(server.calls.brainstormChat).toHaveBeenCalledWith(expect.objectContaining({
      revision_context: { prior_rfc: '# Blueprint', requested_changes: 'Fix tests' },
      failure_context: expect.stringContaining('failed check'),
    }));
    const launch = byClass('guided-launch-bar__launch'); expect(propsOf(launch).disabled).toBe(false);
    await launchAndConfirm();
    expect(server.calls.requestChanges).toHaveBeenCalledWith('run-1', expect.stringContaining('# Revised blueprint'));
    expect(server.calls.startRun).not.toHaveBeenCalled();
    expect(server.saved().active_run_id).toBe('run-2');
    expect(propsOf(byClass('guided-workbench__body'))['data-step']).toBe('live');
  });

  test.each([
    ['Undo latest revision', 'revert_revision', shaB],
    ['Abandon all revisions', 'abandon_all', shaA],
  ])('request changes moves A→B→C through Blueprint and %s targets the selected SHA', async (label, mode, target) => {
    const saved = blueprintSession(); saved.active_stage = 'signoff'; saved.active_run_id = 'run-1';
    server = fakeServer(saved);
    server.runs.set('run-1', snap({ id: 'run-1', status: 'READY_FOR_FINAL_GATE', parent_run_id: null,
      base_ref: 'main', start_sha: shaA, result_sha: shaB }));
    await mount();
    await click(button('Request Changes'));
    const note = byClass('guided-sign-off__note');
    await act(async () => { (propsOf(note).onChange as (event: unknown) => void)({ currentTarget: { value: 'Add coverage' } }); });
    await click(button('Request Changes'));
    expect(propsOf(byClass('guided-workbench__body'))['data-step']).toBe('brainstorm');
    expect(server.calls.stopAndReplan).toHaveBeenCalledOnce();
    await unmount();
    await mount();
    expect(propsOf(byClass('guided-brainstorm__input')).value).toBe('Add coverage');
    await submitRevision('Add coverage');
    expect(server.calls.brainstormChat.mock.calls.at(-1)?.[0]).not.toHaveProperty('failure_context');
    await launchAndConfirm();
    expect(server.calls.requestChanges).toHaveBeenCalledWith('run-1', expect.stringContaining('Add coverage'));
    const child = server.runs.get('run-2')!;
    expect(child.run).toMatchObject({ parent_run_id: 'run-1', start_sha: shaB, result_sha: shaC });
    child.run!.status = 'READY_FOR_FINAL_GATE';
    await unmount(); await mount();
    expect(propsOf(byClass('guided-workbench__body'))['data-step']).toBe('signoff');
    await click(button(label));
    expect(container.textContent).toContain(target);
    await click(button('Confirm rollback'));
    expect(server.calls.rollbackRun).toHaveBeenCalledWith('run-2', mode);
    expect(propsOf(byClass('guided-workbench__body'))['data-step']).toBe('signoff');
    await unmount(); await mount();
    expect(propsOf(byClass('guided-workbench__body'))['data-step']).toBe('signoff');
    await click(button('Stop & Replan'));
    const group = findNode(container, (_node, props) => props.role === 'group' && props['aria-label'] === 'Stop & Replan');
    assert(group);
    const confirm = findNode(group, (node) => node.nodeName === 'BUTTON' && node.textContent === 'Stop & Replan');
    assert(confirm); await click(confirm);
    expect(propsOf(byClass('guided-workbench__body'))['data-step']).toBe('brainstorm');
  });

  test('merge completion stays on Sign-Off and exposes guarded undo', async () => {
    const saved = blueprintSession(); saved.active_stage = 'signoff'; saved.active_run_id = 'run-1';
    server = fakeServer(saved);
    server.runs.set('run-1', snap({ id: 'run-1', status: 'READY_FOR_FINAL_GATE', parent_run_id: null,
      base_ref: 'main', start_sha: shaA, result_sha: shaB }));
    await mount();
    await click(button('Approve & Merge'));
    expect(server.calls.finalizeRun).toHaveBeenCalledOnce();
    expect(propsOf(byClass('guided-workbench__body'))['data-step']).toBe('signoff');
    await unmount(); await mount();
    await click(button('Undo merged changes'));
    await click(button('Confirm rollback'));
    expect(server.calls.rollbackRun).toHaveBeenCalledWith('run-1', 'undo');
    expect(propsOf(byClass('guided-workbench__body'))['data-step']).toBe('signoff');
  });

  test('Start over resets the saved draft and returns to Workspace', async () => {
    server = fakeServer(blueprintSession()); await mount();
    await click(button('Start a new session'));
    await click(button('Discard and reset'));
    expect(server.calls.resetGuidedSession).toHaveBeenCalledOnce();
    expect(server.saved().brainstorm.latest_rfc_draft).toBe('');
    expect(propsOf(byClass('guided-workbench__body'))['data-step']).toBe('setup');
    await click(button('Use team'));
    expect(propsOf(byClass('guided-workbench__body'))['data-step']).toBe('brainstorm');
  });

  test('Workspace & Tools opens from the readiness capsule without leaving Blueprint, also after a refresh', async () => {
    server = fakeServer(blueprintSession()); await mount();
    expect(propsOf(byClass('guided-workbench__setup')).hidden).toBe(true);
    await click(byClass('readiness-capsule__pill'));
    expect(propsOf(byClass('guided-workbench__setup')).hidden).toBe(false);
    expect(server.saved().active_stage).toBe('blueprint');
    expect(propsOf(byClass('guided-workbench__body'))['data-step']).toBe('brainstorm');
    await unmount(); await mount();
    expect(propsOf(byClass('guided-workbench__body'))['data-step']).toBe('brainstorm');
  });

  test('does not leave Workspace before its Blueprint transition is saved', async () => {
    server = fakeServer(session('setup'));
    const write = server.calls.saveGuidedSession.getMockImplementation()!;
    let finish!: () => void;
    server.calls.saveGuidedSession.mockImplementationOnce(async (patch) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return write(patch);
    });
    await mount(); await click(button('Use team'));
    expect(propsOf(byClass('guided-workbench__body'))['data-step']).toBe('setup');
    await act(async () => { finish(); });
    expect(propsOf(byClass('guided-workbench__body'))['data-step']).toBe('brainstorm');
    expect(server.saved().active_stage).toBe('blueprint');
  });
});

describe('revision response recovery', () => {
  test.each([true, false])('only follows a child whose recorded request matches the saved intent: %s', async (matching) => {
    const saved = blueprintSession();
    saved.active_run_id = 'run-1';
    const context = { ok: true, status: 'SUPERSEDED', run_id: 'run-1', failed_tasks: [], last_errors: {},
      current_sha: shaB, run_summary: '' };
    saved.brainstorm.replan_contexts = { 'run-1': JSON.stringify(context) };
    saved.brainstorm.guided_revision = JSON.stringify({ run_id: 'run-1', requested_changes: 'Add coverage' });
    const payload = { launch_request_id: 'same-key', rfc_markdown: '# Revised', mode: 'overnight' as const,
      lineup: recommendation.lineup, preset: null };
    saved.workflow.guided_pending_launch = JSON.stringify(payload);
    const server = fakeServer(saved);
    const parent = snap({ id: 'run-1', status: 'SUPERSEDED', parent_run_id: null,
      base_ref: 'main', start_sha: shaA, result_sha: shaB });
    parent.events.push({ kind: 'revision_requested', message: matching
      ? 'Add coverage\n\nRevised blueprint:\n\n# Revised' : 'A different request',
    payload: { revision_run_id: 'run-2' } });
    server.runs.set('run-1', parent);
    server.runs.set('run-2', snap({ id: 'run-2', status: 'RUNNING', parent_run_id: 'run-1',
      base_ref: 'main', start_sha: shaB, result_sha: shaC }));
    server.calls.requestChanges.mockRejectedValue(new ApiError(409, 'already superseded', { code: 'RUN_SUPERSEDED' }));
    if (matching) {
      await expect(startReplannedRevision(server.client, 'run-1', payload)).resolves.toBe('run-2');
      expect(server.saved().active_run_id).toBe('run-2');
    } else {
      await expect(startReplannedRevision(server.client, 'run-1', payload)).rejects.toThrow('already superseded');
      expect(server.saved().active_run_id).toBe('run-1');
    }
  });
});
