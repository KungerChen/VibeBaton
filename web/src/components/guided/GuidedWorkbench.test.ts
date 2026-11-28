import { act, Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, assert, describe, expect, test, vi } from 'vitest';
import {
  ApiError, type ApiMode, type BatonApiClient, type CliDriver, type GuidedSession, type GuidedSessionPatch,
  type RecommendedLineup, type RunHandoff, type RunHandoffsResponse, type StopAndReplanResult, type WorkflowLineup,
  type WorkspaceInfo,
} from '../../api/client';
import { MESSAGES } from '../../i18n/messages';
import type { LiveRunSnapshot } from '../../types/graph';
import workbenchSource from './GuidedWorkbench.tsx?raw';
import { ContextDrawer, RelayNodePanel, RunOverviewPanel } from './ContextDrawer';
import { GuidedDecisionDrawer } from './GuidedDecisionDrawer';
import { HandoffCard } from './HandoffCard';
import { GuidedFailedBanner } from './GuidedFailedBanner';
import { GuidedBrainstormStep, type GuidedBrainstormApi } from './GuidedBrainstormStep';
import { GuidedSetupStep, type SetupReadinessInput, type SetupReadinessReport } from './GuidedSetupStep';
import { GuidedSignOffPanel } from './GuidedSignOffPanel';
import { NodeDetailDrawer } from './NodeDetailDrawer';
import { ReadinessCapsule } from './ReadinessCapsule';
import type { GuidedSessionState } from './useGuidedSession';
import {
  GUIDED_STEPS,
  GuidedWorkbench,
  nextStep,
  replanContextFromSession,
  signOffSummaryFromSnapshot,
  stepFromRun,
  taskIdFromNodeId,
  useGuidedWorkbenchView,
  waitingDecision,
  type RelaySelection,
} from './GuidedWorkbench';

function snapshot(run: Record<string, unknown> | null, extra: Partial<LiveRunSnapshot> = {}): LiveRunSnapshot {
  return { run, milestones: [], tasks: [], events: [], quotas: [], ...extra };
}

describe('nextStep', () => {
  test('walks setup -> brainstorm -> live -> signoff and stays on signoff', () => {
    expect(GUIDED_STEPS).toEqual(['setup', 'brainstorm', 'live', 'signoff']);
    expect(nextStep('setup')).toBe('brainstorm');
    expect(nextStep('brainstorm')).toBe('live');
    expect(nextStep('live')).toBe('signoff');
    expect(nextStep('signoff')).toBe('signoff');
  });
});

describe('stepFromRun', () => {
  test('returns null until the run reports a status', () => {
    expect(stepFromRun(undefined)).toBeNull();
    expect(stepFromRun(null)).toBeNull();
    expect(stepFromRun('')).toBeNull();
    expect(stepFromRun(42)).toBeNull();
  });

  test('final-gate and completed runs go to sign-off', () => {
    expect(stepFromRun('READY_FOR_FINAL_GATE')).toBe('signoff');
    expect(stepFromRun('COMPLETED')).toBe('signoff');
    expect(stepFromRun(' completed ')).toBe('signoff');
  });

  test('every other status stays on the live build view', () => {
    for (const status of ['PLANNING', 'RUNNING', 'WAITING_HUMAN', 'PAUSED', 'FAILED']) {
      expect(stepFromRun(status), status).toBe('live');
    }
  });
});

describe('taskIdFromNodeId', () => {
  test('maps live task nodes to task ids and ignores other nodes', () => {
    expect(taskIdFromNodeId('live-task-M1-T2')).toBe('M1-T2');
    expect(taskIdFromNodeId('live-task-')).toBeNull();
    expect(taskIdFromNodeId('live-ms-M1')).toBeNull();
    expect(taskIdFromNodeId('live-planner')).toBeNull();
  });
});

describe('waitingDecision', () => {
  const attention = {
    id: 7,
    kind: 'human_attention_required',
    task_id: 'M1-T1',
    message: 'Merge conflict needs a call',
    payload_json: JSON.stringify({ category: 'waiting_human' }),
  };

  test('is null unless the run is WAITING_HUMAN', () => {
    expect(waitingDecision(null)).toBeNull();
    expect(waitingDecision(snapshot({ id: 'r1', status: 'RUNNING' }, { events: [attention] }))).toBeNull();
  });

  test('reads the task and question from the latest waiting_human event', () => {
    const decision = waitingDecision(snapshot(
      { id: 'r1', status: 'WAITING_HUMAN', human_prompt: 'Approve the conflicting change?' },
      { events: [attention] },
    ));
    expect(decision).toMatchObject({ taskId: 'M1-T1', question: 'Approve the conflicting change?', key: 'r1|M1-T1|7' });
    expect(decision?.options.map(({ id }) => id)).toEqual(['approve', 'reject']);
  });

  test('falls back to a WAITING_HUMAN task and returns null without any task id', () => {
    const run = { id: 'r1', status: 'WAITING_HUMAN', updated_at: 5 };
    expect(waitingDecision(snapshot(run, { tasks: [{ id: 'M1-T3', status: 'WAITING_HUMAN' }] }))?.taskId).toBe('M1-T3');
    expect(waitingDecision(snapshot(run))).toBeNull();
  });

  test('ignores stale waiting_human events older than the latest human_decision', () => {
    const stale = {
      id: 3,
      kind: 'human_attention_required',
      task_id: 'M1-T1',
      message: 'Old question',
      payload_json: JSON.stringify({ category: 'waiting_human' }),
    };
    const resolved = { id: 4, kind: 'human_decision', task_id: 'M1-T1', message: 'Resolved' };
    const decision = waitingDecision(snapshot(
      { id: 'r1', status: 'WAITING_HUMAN', human_prompt: 'New milestone issue' },
      {
        tasks: [{ id: 'M1-T2', status: 'WAITING_HUMAN' }],
        events: [stale, resolved],
      },
    ));
    expect(decision?.taskId).toBe('M1-T2');
    expect(decision?.question).toBe('New milestone issue');
  });
});

describe('signOffSummaryFromSnapshot', () => {
  test('counts passed tasks and unions changed files from task events', () => {
    const summary = signOffSummaryFromSnapshot(snapshot({ id: 'r1', status: 'READY_FOR_FINAL_GATE' }, {
      tasks: [{ id: 'a', status: 'PASSED' }, { id: 'b', status: 'PASSED' }, { id: 'c', status: 'FAILED' }],
      events: [
        { kind: 'task_passed', payload_json: JSON.stringify({ changed_files: ['a.ts', 'b.ts'] }) },
        { kind: 'task_passed', payload: { changed_files: ['b.ts', 'c.ts'] } },
        { kind: 'note', payload_json: 'not json' },
      ],
    }));
    expect(summary).toEqual({ testsPassed: 2, testsTotal: 3, changedFiles: ['a.ts', 'b.ts', 'c.ts'], reportUrl: '' });
  });
});

describe('GuidedWorkbench', () => {
  test('the rail numbers only Blueprint, Build and Sign-Off; readiness is not a numbered step', () => {
    for (const locale of ['en', 'zh'] as const) {
      const html = renderToStaticMarkup(createElement(GuidedWorkbench, {
        locale,
        client: {} as BatonApiClient,
        liveSnapshot: null,
        onFollowRun: () => {},
      }));
      const steps = MESSAGES[locale].guided.steps;
      expect(steps.map(({ title }) => title)).toEqual(locale === 'en' ? ['Blueprint', 'Build', 'Sign-Off'] : ['蓝图', '施工', '验收']);
      const rail = /<ol class="guided-workbench__rail"[^>]*>([\s\S]*?)<\/ol>/.exec(html)?.[1] ?? '';
      expect(rail.match(/<li/g)).toHaveLength(3);
      for (const [index, { title }] of steps.entries()) {
        expect(rail).toContain(`<span class="guided-workbench__step-index" aria-hidden="true">${index + 1}</span>`);
        expect(rail).toContain(title);
      }
      expect(rail).not.toContain(MESSAGES[locale].guided.m3.stepper.setup);
      // Before a stage is reached nothing on the rail is current.
      expect(html).toContain('data-step="setup"');
      expect(rail).not.toContain('aria-current');
    }
  });

  test('preserves customized team lineup; the Blueprint body has no workspace bar or step-1 return', () => {
    expect(workbenchSource).toContain('initialRoles={lineup?.roles ?? null}');
    expect(workbenchSource).toContain('apiMode={apiMode}');
    expect(workbenchSource).not.toContain('guided-workbench__team-bar');
    expect(workbenchSource).not.toContain('guided-workbench__step-btn');
  });
});

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) => isValidElement<Record<string, unknown>>(child)
    ? [child, ...elements(child.props.children as ReactNode)] : []);
}

function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = result[key];
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      && existing && typeof existing === 'object' && !Array.isArray(existing)
      ? merge(existing as Record<string, unknown>, value as Record<string, unknown>) : value;
  }
  return result;
}

function buildSession(): GuidedSession {
  const lineup = { ready: true, roles: { brainstorm_and_final_gate: 'codex' }, model_overrides: {}, source: 'cli', notes_en: '', notes_zh: '' };
  return {
    schema_version: 1, active_stage: 'build', workspace_path: '/repo',
    brainstorm: { messages: [], checklist: [], latest_rfc_draft: '# Original RFC', selected_l0_model: null, has_online_draft: true },
    workflow: { mode: 'overnight', lineup: { roles: lineup.roles, model_overrides: {} }, preset: null,
      panel_enabled: false, launch_request_id: null, guided_selected_lineup: lineup },
    active_run_id: 'r1', open_human_gate: null, open_drawer: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

const workspaceInfo: WorkspaceInfo = { path: '/repo', is_git_repo: true, branch: 'main', has_commits: true, has_rfc: false };
const codexDriver: CliDriver = {
  id: 'codex', name: 'Codex', tier: 'official', binary: 'codex', summary_en: '', summary_zh: '', prereq: [],
  install_cmd: [], login_cmd: [], official_url: '', command_template: [], version_cmd: [], provider_ids: ['codex'], env_keys: [],
};
const readyTeam: RecommendedLineup = {
  ready: true, roles: { brainstorm_and_final_gate: 'codex' }, model_overrides: {}, source: 'cli', notes_en: '', notes_zh: '',
};

/** What the wizard reports: the folder, one Codex tool and the team the scan recommends. */
function readinessInput(options: { ready?: boolean; workspace?: Partial<WorkspaceInfo> } = {}): SetupReadinessInput {
  const ready = options.ready ?? true;
  return {
    workspace: { ...workspaceInfo, ...options.workspace },
    drivers: [codexDriver],
    scan: {
      drivers: [{ id: 'codex', status: ready ? 'ready' : 'missing', binary_path: null, version: null, prereq_missing: [],
        reason_en: '', reason_zh: '' }],
      http_api_keys_present: [], scanned_at: 1,
    },
    recommended: ready ? readyTeam : { ready: false, roles: {}, source: 'cli', notes_en: '', notes_zh: '' },
  };
}

describe('GuidedWorkbench live interactions', () => {
  let root: Root | undefined;
  let view: ReactNode;
  let stored: GuidedSession;
  let current: LiveRunSnapshot;
  let api: BatonApiClient;
  let follow: ReturnType<typeof vi.fn>;
  let resetSpy: ReturnType<typeof vi.fn>;
  let mode: ApiMode | null | undefined;

  function find(predicate: (node: ReactElement<Record<string, unknown>>) => boolean) {
    const node = elements(view).find(predicate);
    assert(node, 'Expected a matching workbench element');
    return node;
  }

  async function mount() {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { HTMLIFrameElement: class HTMLIFrameElement {} });
    const container = { nodeType: 1, tagName: 'DIV', ownerDocument: null, addEventListener() {} };
    root = createRoot(container as unknown as HTMLElement);
    function Probe() {
      view = useGuidedWorkbenchView({
        locale: 'en', client: api, apiMode: mode, liveSnapshot: current, onFollowRun: follow, onResetSession: resetSpy,
      });
      return null;
    }
    await act(async () => { root!.render(createElement(Probe)); });
    return async () => { await act(async () => { root!.render(createElement(Probe)); }); };
  }

  function setup(run: LiveRunSnapshot) {
    vi.useFakeTimers();
    stored = buildSession();
    current = run;
    mode = undefined;
    follow = vi.fn();
    resetSpy = vi.fn();
    api = {
      getGuidedSession: vi.fn(async () => structuredClone(stored)),
      saveGuidedSession: vi.fn(async (patch: GuidedSessionPatch) => {
        stored = merge(stored, patch as Record<string, unknown>) as unknown as GuidedSession;
        return structuredClone(stored);
      }),
      resetGuidedSession: vi.fn(),
      getWorkspaceInfo: vi.fn(async () => ({ path: '/repo' })),
      getRun: vi.fn(async () => current),
      getLatestRun: vi.fn(async () => snapshot({ id: 'r2', status: 'RUNNING' })),
      brainstormChat: vi.fn(async () => ({})),
      brainstormConfirm: vi.fn(), startRun: vi.fn(), resolveRunTask: vi.fn(),
    } as unknown as BatonApiClient;
  }

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('restores a pending gate and leaves the canvas and task inspector interactive across refresh', async () => {
    setup(snapshot({ id: 'r1', status: 'WAITING_HUMAN', human_prompt: 'Choose' }, {
      tasks: [{ id: 'T1', status: 'WAITING_HUMAN' }],
    }));
    stored.open_human_gate = { run_id: 'r1', task_id: 'T1' };
    await mount();
    expect(follow).toHaveBeenCalledWith('r1');
    expect(find((node) => node.type === GuidedDecisionDrawer).props.open).toBe(true);
    const canvas = find((node) => typeof node.type === 'function' && node.type.name === 'GuidedLiveCanvas');
    await act(async () => { (canvas.props.onSelect as (selection: RelaySelection) => void)({ kind: 'node', id: 'live-task-T1' }); vi.advanceTimersByTime(400); });
    expect(find((node) => node.type === NodeDetailDrawer).props.taskId).toBe('T1');
    expect(find((node) => node.type === GuidedDecisionDrawer)).toBeTruthy();
    expect(stored.open_drawer).toEqual({ run_id: 'r1', task_id: 'T1' });
    expect(stored.open_human_gate).toEqual({ run_id: 'r1', task_id: 'T1' });
    act(() => root!.unmount());
    root = undefined;
    await mount();
    expect(find((node) => node.type === NodeDetailDrawer).props.taskId).toBe('T1');
    expect(find((node) => node.type === GuidedDecisionDrawer).props.open).toBe(true);
  });

  test('retries session restoration after the shared client finishes its initial health check', async () => {
    setup(snapshot({ id: 'r1', status: 'WAITING_HUMAN' }, { tasks: [{ id: 'T1', status: 'WAITING_HUMAN' }] }));
    mode = null;
    api.getGuidedSession = vi.fn().mockRejectedValueOnce(new ApiError(0, 'Not available in standalone demo'))
      .mockImplementation(async () => structuredClone(stored));
    const rerender = await mount();
    expect(follow).not.toHaveBeenCalled();
    mode = 'local';
    await rerender();
    expect(api.getGuidedSession).toHaveBeenCalledTimes(2);
    expect(follow).toHaveBeenCalledWith('r1');
    expect(find((node) => node.type === GuidedDecisionDrawer)).toBeTruthy();
  });

  test('confirms once, waits for the stopped run and saves failure context before opening Step 2', async () => {
    setup(snapshot({ id: 'r1', status: 'FAILED', summary: 'Build failed' }));
    const stop = deferred<StopAndReplanResult>();
    const reading = deferred<LiveRunSnapshot>();
    const context: StopAndReplanResult = { ok: true, status: 'SUPERSEDED', run_id: 'r1',
      failed_tasks: [{ id: 'T1', title: 'Check' }], last_errors: { T1: 'Tests failed' }, current_sha: 'abc', run_summary: 'Build failed' };
    api.stopAndReplan = vi.fn(() => stop.promise);
    api.getRun = vi.fn(() => reading.promise);
    await mount();
    const banner = find((node) => node.type === GuidedFailedBanner);
    expect(banner.props.detail).toBe('Build failed');
    await act(async () => { (banner.props.onStopAndReplan as () => void)(); });
    const confirm = find((node) => node.type === 'button' && node.props.className === 'guided-workbench__button guided-workbench__button--primary');
    await act(async () => { (confirm.props.onClick as () => void)(); (confirm.props.onClick as () => void)(); });
    expect(api.stopAndReplan).toHaveBeenCalledOnce();
    expect(find((node) => node.type === GuidedFailedBanner).props.busy).toBe(true);
    stored.active_stage = 'blueprint'; // The successful stop endpoint updates the server session.
    await act(async () => { stop.resolve(context); });
    expect(find((node) => node.type === 'section' && node.props['data-step'] === 'live')).toBeTruthy();
    expect(api.getRun).toHaveBeenCalledOnce();
    await act(async () => { reading.resolve(snapshot({ id: 'r1', status: 'SUPERSEDED' })); });
    expect(stored.active_stage).toBe('blueprint');
    expect(replanContextFromSession(stored)).toEqual(context);
    expect(find((node) => node.type === 'section' && node.props['data-step'] === 'brainstorm')).toBeTruthy();
    const brainstorm = find((node) => node.type === GuidedBrainstormStep);
    const chatApi = brainstorm.props.api as GuidedBrainstormApi;
    await act(async () => { await chatApi.brainstormChat({ messages: [{ role: 'user', content: 'Fix the checks' }] }); });
    expect(api.brainstormChat).toHaveBeenCalledWith(expect.objectContaining({
      revision_context: { prior_rfc: '# Original RFC', requested_changes: 'Fix the checks' },
      failure_context: expect.stringContaining('Tests failed'),
    }));
    stored.brainstorm.latest_rfc_draft = '# Revised RFC';
    await act(async () => { await chatApi.brainstormChat({ messages: [{ role: 'user', content: 'Add coverage' }] }); });
    expect(api.brainstormChat).toHaveBeenLastCalledWith(expect.objectContaining({
      revision_context: { prior_rfc: '# Revised RFC', requested_changes: 'Add coverage' },
    }));
    stored.active_run_id = 'another-run';
    await act(async () => {
      await expect(chatApi.brainstormChat({ messages: [{ role: 'user', content: 'Next' }] }))
        .rejects.toThrow(MESSAGES.en.guided.m3.brainstorm.stale);
    });
    expect(api.brainstormChat).toHaveBeenCalledTimes(2);
  });

  test('a superseded 409 removes actions and returns to the current run', async () => {
    setup(snapshot({ id: 'r1', status: 'FAILED', summary: 'failed' }));
    api.stopAndReplan = vi.fn().mockRejectedValue(new ApiError(409, 'old run', { code: 'RUN_SUPERSEDED' }));
    await mount();
    await act(async () => { (find((node) => node.type === GuidedFailedBanner).props.onStopAndReplan as () => void)(); });
    const confirm = find((node) => node.type === 'button' && node.props.className === 'guided-workbench__button guided-workbench__button--primary');
    await act(async () => { (confirm.props.onClick as () => void)(); });
    expect(elements(view).some((node) => node.type === GuidedFailedBanner || node.type === GuidedDecisionDrawer)).toBe(false);
    const back = find((node) => node.type === 'button' && node.props.children === 'Go to current run');
    await act(async () => { (back.props.onClick as () => void)(); });
    expect(follow).toHaveBeenLastCalledWith('r2');
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(stored.active_run_id).toBe('r2');
  });

  test('returning from an old run follows the run already selected by the server session', async () => {
    setup(snapshot({ id: 'r1', status: 'SUPERSEDED' }));
    api.getRun = vi.fn(async () => snapshot({ id: 'r2', status: 'RUNNING' }));
    await mount();
    stored.active_run_id = 'r2';
    const back = find((node) => node.type === 'button' && node.props.children === 'Go to current run');
    await act(async () => { (back.props.onClick as () => void)(); });
    expect(api.getRun).toHaveBeenCalledWith('r2');
    expect(follow).toHaveBeenLastCalledWith('r2');
    expect(api.saveGuidedSession).not.toHaveBeenCalled();
  });

  test('does not send a stop request if its recovery intent cannot be saved', async () => {
    setup(snapshot({ id: 'r1', status: 'FAILED' }));
    api.stopAndReplan = vi.fn();
    api.saveGuidedSession = vi.fn().mockRejectedValue(new Error('session write failed'));
    await mount();
    await act(async () => { (find((node) => node.type === GuidedFailedBanner).props.onStopAndReplan as () => void)(); });
    const confirm = find((node) => node.type === 'button' && node.props.className === 'guided-workbench__button guided-workbench__button--primary');
    await act(async () => { (confirm.props.onClick as () => void)(); });
    expect(api.stopAndReplan).not.toHaveBeenCalled();
    expect(find((node) => node.props.role === 'alert' && node.props.children === 'session write failed')).toBeTruthy();
    expect(find((node) => node.type === GuidedFailedBanner).props.busy).toBe(false);
  });

  test('does not stop the previous run when the session changes during intent persistence', async () => {
    setup(snapshot({ id: 'r1', status: 'FAILED' }));
    api.stopAndReplan = vi.fn();
    api.saveGuidedSession = vi.fn(async (patch: GuidedSessionPatch) => {
      stored.active_run_id = 'r2';
      stored = merge(stored, patch as Record<string, unknown>) as unknown as GuidedSession;
      return structuredClone(stored);
    });
    await mount();
    await act(async () => { (find((node) => node.type === GuidedFailedBanner).props.onStopAndReplan as () => void)(); });
    const confirm = find((node) => node.type === 'button' && node.props.className === 'guided-workbench__button guided-workbench__button--primary');
    await act(async () => { (confirm.props.onClick as () => void)(); });
    expect(api.stopAndReplan).not.toHaveBeenCalled();
    expect(stored.active_run_id).toBe('r2');
    expect(find((node) => node.props.children === 'Go to current run')).toBeTruthy();
  });

  test('STOP_PENDING stays retryable rather than falsely marking the run superseded', async () => {
    setup(snapshot({ id: 'r1', status: 'FAILED' }));
    api.stopAndReplan = vi.fn().mockRejectedValue(new ApiError(409, 'still settling', { code: 'STOP_PENDING' }));
    await mount();
    await act(async () => { (find((node) => node.type === GuidedFailedBanner).props.onStopAndReplan as () => void)(); });
    const confirm = find((node) => node.type === 'button' && node.props.className === 'guided-workbench__button guided-workbench__button--primary');
    await act(async () => { (confirm.props.onClick as () => void)(); });
    expect(find((node) => node.props.children === 'Retry stop')).toBeTruthy();
    expect(find((node) => node.props.role === 'alert' && node.props.children === 'still settling')).toBeTruthy();
    expect(elements(view).some((node) => node.props.children === 'Go to current run')).toBe(false);
    expect(stored.replan_pending).toEqual({ r1: JSON.stringify({ run_id: 'r1', result: null }) });
    current = snapshot({ id: 'r1', status: 'PAUSED' });
    act(() => root!.unmount());
    root = undefined;
    await mount();
    expect(find((node) => node.props.children === 'Retry stop')).toBeTruthy();
    expect(elements(view).some((node) => node.props.children === MESSAGES.en.guided.workbench.resumeRun)).toBe(false);
  });

  test('restores an already returned stop result and waits through a non-superseded snapshot', async () => {
    setup(snapshot({ id: 'r1', status: 'FAILED' }));
    const context: StopAndReplanResult = { ok: true, status: 'SUPERSEDED', run_id: 'r1',
      failed_tasks: [], last_errors: { T1: 'failed' }, current_sha: 'abc', run_summary: 'failed' };
    stored.active_stage = 'blueprint';
    stored.replan_pending = { r1: JSON.stringify({ run_id: 'r1', result: context }) };
    api.getRun = vi.fn(async () => current);
    api.stopAndReplan = vi.fn();
    await mount();
    expect(find((node) => node.type === 'section' && node.props['data-step'] === 'live')).toBeTruthy();
    expect(api.stopAndReplan).not.toHaveBeenCalled();
    expect(stored.replan_pending).toEqual({ r1: JSON.stringify({ run_id: 'r1', result: context }) });
    current = snapshot({ id: 'r1', status: 'SUPERSEDED' });
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(find((node) => node.type === 'section' && node.props['data-step'] === 'brainstorm')).toBeTruthy();
    expect(stored.replan_pending).toEqual({ r1: null });
    expect(replanContextFromSession(stored)).toEqual(context);
  });

  test('does not overwrite a newer active run when the previous stop finishes', async () => {
    setup(snapshot({ id: 'r1', status: 'FAILED' }));
    const context: StopAndReplanResult = { ok: true, status: 'SUPERSEDED', run_id: 'r1',
      failed_tasks: [], last_errors: {}, current_sha: 'abc', run_summary: 'failed' };
    stored.active_stage = 'blueprint';
    stored.replan_pending = { r1: JSON.stringify({ run_id: 'r1', result: context }) };
    const reading = deferred<LiveRunSnapshot>();
    api.getRun = vi.fn(() => reading.promise);
    await mount();
    stored.active_run_id = 'r2';
    stored.active_stage = 'build';
    await act(async () => { reading.resolve(snapshot({ id: 'r1', status: 'SUPERSEDED' })); });
    expect(stored.active_run_id).toBe('r2');
    expect(stored.active_stage).toBe('build');
    expect(stored.brainstorm.replan_contexts).toBeUndefined();
    expect(find((node) => node.props.children === 'Go to current run')).toBeTruthy();
  });

  test('a concurrent run switch during the session write preserves the newer stop and stays read-only', async () => {
    setup(snapshot({ id: 'r1', status: 'SUPERSEDED' }));
    const context: StopAndReplanResult = { ok: true, status: 'SUPERSEDED', run_id: 'r1',
      failed_tasks: [], last_errors: {}, current_sha: 'abc', run_summary: 'failed' };
    stored.active_stage = 'blueprint';
    stored.replan_pending = { r1: JSON.stringify({ run_id: 'r1', result: context }) };
    api.getRun = vi.fn(async () => snapshot({ id: 'r1', status: 'SUPERSEDED' }));
    api.saveGuidedSession = vi.fn(async (patch: GuidedSessionPatch) => {
      if (patch.brainstorm?.replan_contexts) {
        stored.active_run_id = 'r2';
        stored.active_stage = 'build';
        stored.replan_pending = { ...(stored.replan_pending as Record<string, unknown>),
          r2: JSON.stringify({ run_id: 'r2', result: null }) };
      }
      stored = merge(stored, patch as Record<string, unknown>) as unknown as GuidedSession;
      return structuredClone(stored);
    });
    await mount();
    expect(stored.active_run_id).toBe('r2');
    expect(stored.active_stage).toBe('build');
    expect(stored.replan_pending).toEqual({ r1: null, r2: JSON.stringify({ run_id: 'r2', result: null }) });
    expect(replanContextFromSession(stored)).toBeNull();
    expect(find((node) => node.props.children === 'Go to current run')).toBeTruthy();
  });

  test('keeps strictly two direct grid children (.guided-workbench__rail and __body) when session is present', async () => {
    setup(snapshot({ id: 'r1', status: 'RUNNING' }));
    await mount();
    const grid = find((node) => node.type === 'div' && node.props.className === 'guided-workbench');
    const directChildren = Children.toArray(grid.props.children as ReactNode).filter(
      (child): child is ReactElement<Record<string, unknown>> => isValidElement(child) && typeof child.type === 'string',
    );
    expect(directChildren.map((child) => child.props.className)).toEqual([
      'guided-workbench__rail',
      'guided-workbench__body',
    ]);
    const body = directChildren[1];
    const sessionBar = elements(body).find(
      (node) => typeof node.props.className === 'string' && node.props.className.includes('guided-workbench__session-bar'),
    );
    expect(sessionBar).toBeTruthy();
  });

  test('invokes onResetSession after resetGuidedSession resolves', async () => {
    setup(snapshot({ id: 'r1', status: 'FAILED' }));
    api.resetGuidedSession = vi.fn(async () => structuredClone(buildSession()));
    await mount();
    const startReset = find((node) => node.type === 'button' && node.props.children === MESSAGES.en.guided.m3.session.reset);
    await act(async () => { (startReset.props.onClick as () => void)(); });
    const confirm = find((node) => node.type === 'button' && node.props.children === MESSAGES.en.guided.m3.session.confirmReset);
    await act(async () => { (confirm.props.onClick as () => void)(); });
    expect(api.resetGuidedSession).toHaveBeenCalledTimes(1);
    expect(resetSpy).toHaveBeenCalledTimes(1);
  });

  const readinessCopy = MESSAGES.en.guided.m3.readiness;
  const body = () => find((node) => node.props.className === 'guided-workbench__body');
  const capsule = () => find((node) => node.type === ReadinessCapsule);
  const wizard = () => find((node) => node.type === GuidedSetupStep);
  const wizardPanel = () => find((node) => node.type === 'div' && typeof node.props.className === 'string'
    && node.props.className.split(' ').includes('guided-workbench__setup'));
  const brainstorm = () => find((node) => node.type === GuidedBrainstormStep);

  /** The wizard reports what it read; `recheck` stands in for reading the folder and scanning again. */
  async function report(input: SetupReadinessInput, recheck = vi.fn(async (): Promise<SetupReadinessInput | null> => input)) {
    await act(async () => {
      (wizard().props.onReadiness as (value: SetupReadinessReport) => void)({ input, checking: false, recheck });
    });
    return recheck;
  }

  function atStage(stage: GuidedSession['active_stage']) {
    setup(snapshot(null));
    stored.active_stage = stage;
    stored.active_run_id = null;
  }

  test('the rail marks the stage of the restored run among its three numbered steps', async () => {
    setup(snapshot({ id: 'r1', status: 'RUNNING' }));
    await mount();
    const rail = find((node) => node.type === 'ol');
    const steps = elements(rail.props.children as ReactNode).filter((node) => node.type === 'li');
    // Children.toArray prefixes each key with ".$".
    expect(steps.map((step) => String(step.key).replace(/^\.\$/, ''))).toEqual(['brainstorm', 'live', 'signoff']);
    expect(steps.map((step) => step.props['aria-current'])).toEqual([undefined, 'step', undefined]);
  });

  test('a new session that is ready goes straight to Blueprint through the saved stage, without showing the wizard', async () => {
    atStage('setup');
    await mount();
    expect(body().props['data-step']).toBe('setup');
    expect(wizardPanel().props.hidden).toBe(true);
    expect(wizard().props.autoContinue).toBe(false);
    expect(find((node) => node.props.role === 'status' && node.props.children === readinessCopy.checkingHint)).toBeTruthy();
    await report(readinessInput());
    expect(wizard().props.autoContinue).toBe(true);
    expect(wizardPanel().props.hidden).toBe(true);
    // autoContinue runs the wizard's own Continue, which hands its team to onReady.
    await act(async () => { (wizard().props.onReady as (team: RecommendedLineup) => void)(readyTeam); });
    expect(stored.active_stage).toBe('blueprint');
    expect(body().props['data-step']).toBe('brainstorm');
    expect(wizard().props.autoContinue).toBe(false);
    expect(wizardPanel().props.hidden).toBe(true);
  });

  test('a session left on setup with something missing opens the wizard and names the reason on the capsule', async () => {
    atStage('setup');
    await mount();
    await report(readinessInput({ ready: false }));
    expect(wizardPanel().props.hidden).toBe(false);
    expect(wizard().props.autoContinue).toBe(false);
    expect(capsule().props.readiness).toEqual({ state: 'blocked', reasons: [{ code: 'no_team' }] });
    expect(body().props['data-step']).toBe('setup');
    expect(stored.active_stage).toBe('setup');
  });

  test('turning red during Build never moves the stage back; the wizard opens only when asked', async () => {
    setup(snapshot({ id: 'r1', status: 'RUNNING' }));
    await mount();
    await report(readinessInput({ workspace: { has_commits: false } }));
    expect(capsule().props.readiness).toEqual({ state: 'blocked', reasons: [{ code: 'no_commits' }] });
    expect(body().props['data-step']).toBe('live');
    expect(wizardPanel().props.hidden).toBe(true);
    await act(async () => { (capsule().props.onToggle as () => void)(); });
    expect(wizardPanel().props.hidden).toBe(false);
    expect(body().props['data-step']).toBe('live');
    // Continue inside the wizard during a run only closes it.
    await act(async () => { (wizard().props.onReady as (team: RecommendedLineup) => void)(readyTeam); vi.advanceTimersByTime(500); });
    expect(wizardPanel().props.hidden).toBe(true);
    expect(body().props['data-step']).toBe('live');
    expect(stored.active_stage).toBe('build');
    expect(api.saveGuidedSession).not.toHaveBeenCalled();
  });

  test('Blueprint with something missing opens the wizard on entry and blocks the launch with a linked reason', async () => {
    atStage('blueprint');
    await mount();
    expect(body().props['data-step']).toBe('brainstorm');
    expect(brainstorm().props.launchBlock).toBeNull();
    expect(wizardPanel().props.hidden).toBe(true);
    await report(readinessInput({ workspace: { is_git_repo: false, branch: null, has_commits: false } }));
    expect(wizardPanel().props.hidden).toBe(false);
    expect(brainstorm().props.launchBlock).toBe(readinessCopy.noGit);
    expect(body().props['data-step']).toBe('brainstorm');
    const hide = find((node) => node.type === 'button' && node.props.children === readinessCopy.hide);
    await act(async () => { (hide.props.onClick as () => void)(); });
    expect(wizardPanel().props.hidden).toBe(true);
    await act(async () => { (brainstorm().props.onOpenSetup as () => void)(); });
    expect(wizardPanel().props.hidden).toBe(false);
    await report(readinessInput());
    expect(brainstorm().props.launchBlock).toBeNull();
    expect(stored.active_stage).toBe('blueprint');
  });

  test('checks again on a manual refresh and right before a launch; only a blocked or failed check stops it', async () => {
    atStage('blueprint');
    await mount();
    const recheck = await report(readinessInput(), vi.fn(async (): Promise<SetupReadinessInput | null> => readinessInput({ ready: false })));
    const team: WorkflowLineup = { roles: { brainstorm_and_final_gate: 'codex' }, model_overrides: {} };
    const check = () => brainstorm().props.checkReadiness as (lineup: WorkflowLineup) => Promise<boolean>;
    let allowed: boolean | undefined;
    await act(async () => { allowed = await check()(team); });
    expect(recheck).toHaveBeenCalledOnce();
    expect(allowed).toBe(false);
    recheck.mockResolvedValueOnce(readinessInput());
    await act(async () => { allowed = await check()(team); });
    expect(allowed).toBe(true);
    // A tool the launched team uses is not ready: partly ready does not stop it; the server checks the team.
    recheck.mockResolvedValueOnce(readinessInput());
    await act(async () => { allowed = await check()({ ...team, roles: { brainstorm_and_final_gate: 'claude_sub' } }); });
    expect(allowed).toBe(true);
    recheck.mockResolvedValueOnce(null);
    await act(async () => { allowed = await check()(team); });
    expect(allowed).toBe(false);
    expect(capsule().props.failed).toBe(true);
    expect(brainstorm().props.launchBlock).toBe(readinessCopy.checkFailed);
    await act(async () => { (capsule().props.onRefresh as () => void)(); });
    expect(recheck).toHaveBeenCalledTimes(5);
    expect(capsule().props.failed).toBe(false);
  });

  test('a changed team is checked against the tools the last scan found', async () => {
    atStage('blueprint');
    await mount();
    await report(readinessInput());
    expect(capsule().props.readiness).toEqual({ state: 'ready', reasons: [] });
    const owner = brainstorm().props.guidedSession as GuidedSessionState;
    await act(async () => { owner.save({ workflow: { lineup: { roles: { brainstorm_and_final_gate: 'claude_sub' } } } }); });
    expect(capsule().props.readiness).toEqual({ state: 'partial', reasons: [{ code: 'tools_unavailable', providers: ['claude_sub'] }] });
    expect(brainstorm().props.launchBlock).toBeNull();
  });

  test('the task drawer and the Sign-Off total get what tells a real zero from a cost nobody reported', async () => {
    setup(snapshot({ id: 'r1', status: 'RUNNING' }, {
      tasks: [{ id: 'T1', status: 'PASSED' }, { id: 'T2', status: 'PASSED' }],
      events: [{ kind: 'role_completed', task_id: 'T1', payload_json: JSON.stringify({ cost_usd: 0 }) }],
    }));
    stored.open_drawer = { run_id: 'r1', task_id: 'T1' };
    const rerender = await mount();
    expect(find((node) => node.type === NodeDetailDrawer).props.costReported).toBe(true);
    const canvas = find((node) => typeof node.type === 'function' && node.type.name === 'GuidedLiveCanvas');
    await act(async () => { (canvas.props.onSelect as (selection: RelaySelection) => void)({ kind: 'node', id: 'live-task-T2' }); });
    expect(find((node) => node.type === NodeDetailDrawer).props.costReported).toBe(false);

    const billing = { total_prompt_tokens: 0, total_completion_tokens: 0, total_cached_tokens: 0, total_tokens: 0,
      total_cost_usd: 0, has_exact_billing: true, total_calls: 3, reported_calls: 1 };
    current = snapshot({ id: 'r1', status: 'READY_FOR_FINAL_GATE' }, { telemetry: { elapsed_sec: 1, stages: [], models: [], billing } });
    await rerender();
    const panel = find((node) => node.type === GuidedSignOffPanel);
    expect(panel.props.summary).toMatchObject({ totalCostUsd: 0, usage: billing });
  });

  // Over a stage the button applies the team and closes the wizard (during a run it only closes it),
  // so only the setup screen may promise "Continue to Blueprint".
  test.each([
    ['setup', undefined],
    ['blueprint', 'Done'],
    ['a run', 'Done'],
  ] as const)('the wizard button on %s has the label %s (none means "Continue to Blueprint")', async (where, label) => {
    if (where === 'a run') setup(snapshot({ id: 'r1', status: 'RUNNING' }));
    else atStage(where);
    await mount();
    await report(readinessInput({ ready: where !== 'setup' }));
    expect(wizard().props.continueLabel).toBe(label);
    expect([readinessCopy.done, MESSAGES.zh.guided.m3.readiness.done]).toEqual(['Done', '完成']);
  });

  test('the capsule sits in the row of "Start a new session" and names the folder; Blueprint has no workspace bar', async () => {
    atStage('blueprint');
    await mount();
    await report(readinessInput());
    const bar = find((node) => typeof node.props.className === 'string' && node.props.className.includes('guided-workbench__session-bar'));
    const inBar = elements(bar.props.children as ReactNode);
    expect(inBar.some((node) => node.type === ReadinessCapsule)).toBe(true);
    expect(inBar.some((node) => node.type === 'button' && node.props.children === MESSAGES.en.guided.m3.session.reset)).toBe(true);
    expect(capsule().props.workspacePath).toBe('/repo');
    expect(elements(view).some((node) => node.props.className === 'guided-workbench__team-bar')).toBe(false);
  });

  function relaySnapshot(extra: Partial<LiveRunSnapshot> = {}, run: Record<string, unknown> = { id: 'r1', status: 'RUNNING' }) {
    return snapshot(run, {
      milestones: [{ id: 'M1', title: 'Core', status: 'RUNNING' }],
      tasks: [{ id: 'T1', milestone_id: 'M1', title: 'Write', status: 'PASSED' },
        { id: 'T2', milestone_id: 'M1', title: 'Check', status: 'RUNNING' }],
      events: [{ id: 5, kind: 'task_passed', task_id: 'T1' }],
      ...extra,
    });
  }
  function relayHandoff(id: string, recorded: boolean): RunHandoff {
    return { id, from: { kind: 'planner', id: null }, to: { kind: 'task', id: 'T1' }, recorded, event_ids: [], at: null,
      invocations: [], changed_files: null, receipts: [], review: null, takeover: { status: null, holder: null }, blocked_reason: null };
  }
  const drawer = () => find((node) => node.type === ContextDrawer);
  const relay = () => find((node) => typeof node.type === 'function' && node.type.name === 'GuidedLiveCanvas');
  async function select(selection: RelaySelection | null) {
    await act(async () => { (relay().props.onSelect as (value: RelaySelection | null) => void)(selection); });
  }

  test('selecting a node or an edge only changes the drawer and never leaves the live view', async () => {
    setup(relaySnapshot());
    const handoffs = [relayHandoff('planner>task:T1', true), relayHandoff('task:T1>milestone:M1', false)];
    api.getRunHandoffs = vi.fn(async () => ({ run_id: 'r1', handoffs }));
    await mount();
    expect(drawer().props.owner).toBe('overview');
    expect(find((node) => node.type === RunOverviewPanel)).toBeTruthy();
    expect(relay().props.handoffs).toEqual(handoffs);
    const graph = relay().props.view;
    const followed = follow.mock.calls.length;
    const saved = vi.mocked(api.saveGuidedSession).mock.calls.length;

    await select({ kind: 'node', id: 'live-ms-M1' });
    expect(drawer().props.owner).toBe('node');
    expect(find((node) => node.type === RelayNodePanel).props.node).toMatchObject({ id: 'live-ms-M1' });
    await select({ kind: 'edge', id: 'live-edge-live-planner-to-live-task-T1' });
    expect(drawer().props.owner).toBe('handoff');
    expect(find((node) => node.type === HandoffCard).props).toMatchObject({
      handoff: handoffs[0], fromLabel: '01_PLAN · Tactical Plan', toLabel: 'T1 · Write',
    });
    await select({ kind: 'edge', id: 'live-edge-live-task-T2-to-live-ms-M1' });
    expect(find((node) => node.type === HandoffCard).props.handoff).toBeNull();
    await select({ kind: 'node', id: 'live-task-T1' });
    expect(drawer().props.owner).toBe('task');
    expect(find((node) => node.type === NodeDetailDrawer).props.taskId).toBe('T1');
    await select(null);
    expect(drawer().props.owner).toBe('overview');
    expect(find((node) => node.type === NodeDetailDrawer).props.taskId).toBeNull();
    await act(async () => { vi.advanceTimersByTime(400); });

    expect(relay().props.view).toBe(graph);
    expect(body().props['data-step']).toBe('live');
    expect(follow).toHaveBeenCalledTimes(followed);
    const patches = vi.mocked(api.saveGuidedSession).mock.calls.slice(saved).map(([patch]) => patch);
    expect(patches.length).toBeGreaterThan(0);
    expect(patches.every((patch) => Object.keys(patch).join() === 'open_drawer')).toBe(true);
    expect(stored.open_drawer).toBeNull();
  });

  test('a pending decision owns the drawer and names its task; once answered the selection is back', async () => {
    setup(relaySnapshot({ tasks: [{ id: 'T1', milestone_id: 'M1', title: 'Write', status: 'WAITING_HUMAN' }] },
      { id: 'r1', status: 'WAITING_HUMAN', human_prompt: 'Keep it?' }));
    await mount();
    expect(drawer().props.owner).toBe('decision');
    await select({ kind: 'edge', id: 'live-edge-live-planner-to-live-task-T1' });
    expect(drawer().props.owner).toBe('decision');
    const gate = find((node) => node.type === GuidedDecisionDrawer);
    expect(gate.props).toMatchObject({ open: true, taskId: 'T1',
      title: 'Task T1 needs a decision from you', submitLabel: 'Reply to task T1' });
    expect(elements(view).some((node) => node.type === HandoffCard)).toBe(false);
    await act(async () => { (gate.props.onResolved as () => void)(); });
    expect(drawer().props.owner).toBe('handoff');
    expect(elements(view).some((node) => node.type === GuidedDecisionDrawer)).toBe(false);
  });

  test('handoffs are read again when the run moves on, and a failed read keeps the last records with a retry', async () => {
    setup(relaySnapshot());
    const first = [relayHandoff('planner>task:T1', true)];
    const read = vi.fn<(runId: string) => Promise<RunHandoffsResponse>>().mockResolvedValueOnce({ run_id: 'r1', handoffs: first });
    api.getRunHandoffs = read;
    const rerender = await mount();
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith('r1');
    current = { ...current };
    await rerender();
    expect(read).toHaveBeenCalledOnce();

    read.mockRejectedValueOnce(new Error('offline'));
    current = relaySnapshot({ events: [{ id: 6, kind: 'task_started', task_id: 'T2' }] });
    await rerender();
    expect(read).toHaveBeenCalledTimes(2);
    expect(relay().props.handoffs).toEqual(first);
    const retryButton = () => elements(view).find((node) => node.type === 'button' && node.props.children === MESSAGES.en.guided.relay.retry);
    expect(find((node) => node.props.children === MESSAGES.en.guided.relay.handoffsFailed)).toBeTruthy();
    const late = deferred<RunHandoffsResponse>();
    read.mockReturnValueOnce(late.promise);
    await act(async () => { (retryButton()!.props.onClick as () => void)(); });
    expect(read).toHaveBeenCalledTimes(3);

    const second = [relayHandoff('planner>task:T1', true), relayHandoff('task:T1>milestone:M1', true)];
    read.mockResolvedValueOnce({ run_id: 'r1', handoffs: second });
    current = relaySnapshot({ events: [{ id: 6, kind: 'task_started', task_id: 'T2' }] }, { id: 'r1', status: 'PAUSED' });
    await rerender();
    expect(read).toHaveBeenCalledTimes(4);
    expect(relay().props.handoffs).toEqual(second);
    expect(retryButton()).toBeUndefined();
    await act(async () => { late.resolve({ run_id: 'r1', handoffs: [] }); });
    expect(relay().props.handoffs).toEqual(second);
  });
});
