import { act, createElement, useCallback, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, assert, describe, expect, test, vi } from 'vitest';
import type { BatonApiClient, CliDriver, GuidedSession, GuidedSessionPatch, WorkspaceInfo } from '../../api/client';
import type { LiveRunSnapshot } from '../../types/graph';
import { GuidedWorkbench } from './GuidedWorkbench';

vi.mock('../CanvasWorkspace', () => ({ CanvasWorkspace: () => createElement('div', { 'data-testid': 'live-canvas' }) }));

// The real workbench with the real Workspace & Tools wizard; only the server and the graph renderer are fakes.
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

const codex: CliDriver = {
  id: 'codex', name: 'Codex', tier: 'official', binary: 'codex', summary_en: '', summary_zh: '', prereq: [],
  install_cmd: ['npm', 'install', '-g', 'codex'], login_cmd: ['codex', 'login'], official_url: 'https://example.invalid',
  command_template: [], version_cmd: [], provider_ids: ['codex_sub'], env_keys: [],
};
const repo: WorkspaceInfo = { path: '/repo', is_git_repo: true, branch: 'main', has_commits: true, has_rfc: false };
const roles = { brainstorm_and_final_gate: 'codex_sub', critical_executor: 'codex_sub' };

function session(stage: GuidedSession['active_stage'], runId: string | null = null): GuidedSession {
  return { schema_version: 1, active_stage: stage, workspace_path: '/repo',
    brainstorm: { messages: [], checklist: [], latest_rfc_draft: '', selected_l0_model: null, has_online_draft: false },
    workflow: { mode: 'overnight', lineup: { roles: runId ? roles : {}, model_overrides: {} }, preset: null, panel_enabled: false,
      launch_request_id: null },
    active_run_id: runId, open_human_gate: null, open_drawer: null };
}

function fakeServer(initial: GuidedSession, options: { workspace?: WorkspaceInfo; toolReady?: boolean } = {}) {
  let saved = structuredClone(initial);
  const ready = options.toolReady ?? true;
  const client = {
    getGuidedSession: vi.fn(async () => structuredClone(saved)),
    saveGuidedSession: vi.fn(async (patch: GuidedSessionPatch) => {
      saved = merge(saved, patch as Record<string, unknown>) as unknown as GuidedSession;
      return structuredClone(saved);
    }),
    resetGuidedSession: vi.fn(),
    getWorkspaceInfo: vi.fn(async () => options.workspace ?? repo),
    getCliRegistry: vi.fn(async () => ({ schema_version: 1, drivers: [codex], tags: [] })),
    scanCliRegistry: vi.fn(async () => ({
      scan: { drivers: [{ id: 'codex', status: ready ? 'ready' : 'missing', binary_path: null, version: null, prereq_missing: [],
        reason_en: '', reason_zh: '' }], http_api_keys_present: [], scanned_at: 1 },
      lineup: ready ? { ready: true, roles, source: 'cli', notes_en: 'Ready.', notes_zh: '就绪。' }
        : { ready: false, roles: {}, source: 'cli', notes_en: 'Install a tool.', notes_zh: '请安装工具。' },
    })),
    getLineupProfiles: vi.fn(async () => ({ profiles: [], last_used: null })),
    saveLastUsedLineup: vi.fn(async () => ({ profiles: [], last_used: null })),
    selectWorkspace: vi.fn(), initGitWorkspace: vi.fn(), installCli: vi.fn(), loginCli: vi.fn(),
    getL0Models: vi.fn(async () => ({ models: [], auto_selected: null })),
    getModelCatalog: vi.fn(async () => { throw new Error('use built-in catalog'); }),
    saveLineupProfile: vi.fn(), deleteLineupProfile: vi.fn(),
    getRolesConfig: vi.fn(async () => ({ budget_profile: 'balanced' })),
    checkRfc: vi.fn(), recommendBlueprint: vi.fn(), brainstormChat: vi.fn(), startRun: vi.fn(),
    getRun: vi.fn(async (id: string): Promise<LiveRunSnapshot> => ({
      run: { id, status: 'RUNNING' }, milestones: [], tasks: [], events: [], quotas: [] })),
  };
  return { client: client as unknown as BatonApiClient, calls: client, saved: () => structuredClone(saved) };
}

describe('the workbench with its real Workspace & Tools wizard', () => {
  let root: Root | undefined;
  let container: TestElement;

  async function mount(server: ReturnType<typeof fakeServer>) {
    const document = new TestDocument();
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', { document, HTMLIFrameElement: class {}, matchMedia: () => ({ matches: true }),
      addEventListener() {}, removeEventListener() {},
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} } });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    root = createRoot(container as unknown as HTMLElement);
    function Host() {
      const [snapshot, setSnapshot] = useState<LiveRunSnapshot | null>(null);
      const follow = useCallback((id: string) => { void server.client.getRun(id).then(setSnapshot); }, []);
      return createElement(GuidedWorkbench, { locale: 'en', apiMode: 'local', client: server.client, liveSnapshot: snapshot, onFollowRun: follow });
    }
    await act(async () => { root!.render(createElement(Host)); });
    for (let turn = 0; turn < 5; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  function byClass(name: string) {
    const node = findNode(container, (_node, props) => typeof props.className === 'string' && props.className.split(' ').includes(name));
    assert(node, `Expected .${name}; got ${container.textContent}`);
    return node;
  }
  const step = () => propsOf(byClass('guided-workbench__body'))['data-step'];
  const capsuleState = () => propsOf(byClass('readiness-capsule'))['data-state'];
  const wizardHidden = () => propsOf(byClass('guided-workbench__setup')).hidden;

  afterEach(async () => {
    if (root) await act(async () => { root!.unmount(); });
    root = undefined;
    vi.unstubAllGlobals();
  });

  test('a new session on a ready workspace lands on Blueprint by itself, saving the stage and the last team once', async () => {
    const server = fakeServer(session('setup'));
    await mount(server);
    expect(step()).toBe('brainstorm');
    expect(server.saved().active_stage).toBe('blueprint');
    expect(capsuleState()).toBe('ready');
    expect(wizardHidden()).toBe(true);
    expect(server.calls.saveLastUsedLineup).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('/repo');
  });

  test('a workspace without Git stays on the wizard with the reason on the capsule', async () => {
    const server = fakeServer(session('setup'), { workspace: { ...repo, is_git_repo: false, branch: null, has_commits: false } });
    await mount(server);
    expect(step()).toBe('setup');
    expect(server.saved().active_stage).toBe('setup');
    expect(capsuleState()).toBe('blocked');
    expect(wizardHidden()).toBe(false);
    expect(propsOf(byClass('readiness-capsule__pill'))['aria-expanded']).toBe(true);
    expect(byClass('readiness-capsule__reason').textContent).toContain('Version history is off for this folder');
    expect(server.calls.saveLastUsedLineup).not.toHaveBeenCalled();
  });

  test('a restored Build session keeps its run and stage when no tool is ready, and does not open the wizard', async () => {
    const server = fakeServer(session('build', 'run-1'), { toolReady: false });
    await mount(server);
    expect(step()).toBe('live');
    expect(capsuleState()).toBe('blocked');
    expect(wizardHidden()).toBe(true);
    expect(server.saved().active_stage).toBe('build');
    expect(server.saved().active_run_id).toBe('run-1');
    expect(server.calls.saveGuidedSession).not.toHaveBeenCalledWith(expect.objectContaining({ active_stage: expect.anything() }));
  });
});
