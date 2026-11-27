import { act, Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, assert, describe, expect, test, vi } from 'vitest';
import { ApiError, type ApiMode, type BatonApiClient, type GuidedSession, type GuidedSessionPatch, type StopAndReplanResult } from '../../api/client';
import { MESSAGES } from '../../i18n/messages';
import type { LiveRunSnapshot } from '../../types/graph';
import workbenchSource from './GuidedWorkbench.tsx?raw';
import { GuidedDecisionDrawer } from './GuidedDecisionDrawer';
import { GuidedFailedBanner } from './GuidedFailedBanner';
import { GuidedBrainstormStep, type GuidedBrainstormApi } from './GuidedBrainstormStep';
import { NodeDetailDrawer } from './NodeDetailDrawer';
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
  test('starts on the workspace step with all four step titles in the rail', () => {
    for (const locale of ['en', 'zh'] as const) {
      const html = renderToStaticMarkup(createElement(GuidedWorkbench, {
        locale,
        client: {} as BatonApiClient,
        liveSnapshot: null,
        onFollowRun: () => {},
      }));
      for (const { title } of MESSAGES[locale].guided.steps) expect(html).toContain(title);
      expect(html).toContain('data-step="setup"');
      expect(html).toContain('aria-current="step"');
    }
  });

  test('preserves customized team lineup and exposes change-team return controls in Brainstorm', () => {
    expect(workbenchSource).toContain('initialRoles={lineup?.roles ?? null}');
    expect(workbenchSource).toContain('apiMode={apiMode}');
    expect(workbenchSource).toContain('copy.workbench.changeTeam');
    expect(workbenchSource).toContain('guided-workbench__step-btn');
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
    await act(async () => { (canvas.props.onTaskClick as (id: string) => void)('T1'); vi.advanceTimersByTime(400); });
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
});
