import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GuidedSession, GuidedSessionPatch } from '../../api/client';
import { createLaunchRequestId, useGuidedSession, type GuidedSessionApi, type GuidedSessionState } from './useGuidedSession';

function initialSession(): GuidedSession {
  return {
    schema_version: 1, active_stage: 'setup', workspace_path: '/repo',
    brainstorm: { messages: [], checklist: [], latest_rfc_draft: '', selected_l0_model: null, has_online_draft: false },
    workflow: { mode: null, lineup: { roles: { old: 'old-provider' }, model_overrides: {} }, preset: null, panel_enabled: false, launch_request_id: null },
    active_run_id: null, open_human_gate: null, open_drawer: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

describe('useGuidedSession', () => {
  let root: Root | undefined;
  let state: GuidedSessionState;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { HTMLIFrameElement: class HTMLIFrameElement {} });
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'stable-launch-id') });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function mount(api: GuidedSessionApi, strict = false) {
    const container = { nodeType: 1, tagName: 'DIV', ownerDocument: null, addEventListener() {} };
    root = createRoot(container as unknown as HTMLElement);
    function Probe({ client }: { client: GuidedSessionApi }) { state = useGuidedSession(client, 400); return null; }
    await act(async () => {
      const element = createElement(Probe, { client: api });
      root!.render(strict ? createElement(StrictMode, null, element) : element);
    });
    return {
      async rerender(client: GuidedSessionApi) {
        await act(async () => { root!.render(createElement(Probe, { client })); });
      },
    };
  }

  test('loads on mount and coalesces edits into a debounced partial save', async () => {
    const loaded = initialSession();
    const saved = { ...loaded, active_stage: 'blueprint' as const, brainstorm: { ...loaded.brainstorm, latest_rfc_draft: '# edited' } };
    const api = { getGuidedSession: vi.fn().mockResolvedValue(loaded), saveGuidedSession: vi.fn().mockResolvedValue(saved), resetGuidedSession: vi.fn() };
    await mount(api);
    expect(state.loading).toBe(false);
    expect(state.session).toEqual(loaded);
    act(() => {
      state.save({ active_stage: 'blueprint' });
      state.save({ brainstorm: { latest_rfc_draft: '# edited' } });
    });
    expect(state.session?.brainstorm.latest_rfc_draft).toBe('# edited');
    await act(async () => { vi.advanceTimersByTime(399); });
    expect(api.saveGuidedSession).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(api.saveGuidedSession).toHaveBeenCalledOnce();
    expect(api.saveGuidedSession).toHaveBeenCalledWith({ active_stage: 'blueprint', brainstorm: { latest_rfc_draft: '# edited' } });
    expect(state.session).toEqual(saved);
  });

  test('serializes writes and keeps a newer edit visible while the first write is in flight', async () => {
    const loaded = initialSession();
    const first = deferred<GuidedSession>();
    const firstSaved = { ...loaded, brainstorm: { ...loaded.brainstorm, latest_rfc_draft: '# first' } };
    const secondSaved = { ...firstSaved, brainstorm: { ...firstSaved.brainstorm, selected_l0_model: 'codex:test' } };
    const api = { getGuidedSession: vi.fn().mockResolvedValue(loaded), saveGuidedSession: vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(secondSaved), resetGuidedSession: vi.fn() };
    await mount(api);
    act(() => state.save({ brainstorm: { latest_rfc_draft: '# first' } }));
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(state.saving).toBe(true);
    act(() => state.save({ brainstorm: { selected_l0_model: 'codex:test' } }));
    expect(state.session?.brainstorm.selected_l0_model).toBe('codex:test');
    expect(api.saveGuidedSession).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve(firstSaved); });
    expect(api.saveGuidedSession).toHaveBeenCalledTimes(2);
    expect(state.session).toEqual(secondSaved);
    expect(state.saving).toBe(false);
  });

  test('preserves map clear followed by additions as two ordered writes', async () => {
    const loaded = initialSession();
    const cleared = { ...loaded, workflow: { ...loaded.workflow, lineup: { roles: {}, model_overrides: {} } } };
    const replaced = { ...cleared, workflow: { ...cleared.workflow, lineup: { roles: { planner: 'new-provider' }, model_overrides: {} } } };
    const api = { getGuidedSession: vi.fn().mockResolvedValue(loaded), saveGuidedSession: vi.fn().mockResolvedValueOnce(cleared).mockResolvedValueOnce(replaced), resetGuidedSession: vi.fn() };
    await mount(api);
    act(() => {
      state.save({ workflow: { lineup: { roles: {} } } });
      state.save({ workflow: { lineup: { roles: { planner: 'new-provider' } } } });
    });
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(api.saveGuidedSession.mock.calls).toEqual([
      [{ workflow: { lineup: { roles: {} } } }],
      [{ workflow: { lineup: { roles: { planner: 'new-provider' } } } }],
    ]);
    expect(state.session?.workflow.lineup.roles).toEqual({ planner: 'new-provider' });
  });

  test('keeps null map deletions in a coalesced server patch', async () => {
    const loaded = initialSession();
    const saved = { ...loaded, workflow: { ...loaded.workflow, lineup: { roles: { planner: 'new' }, model_overrides: {} } } };
    const api = { getGuidedSession: vi.fn().mockResolvedValue(loaded), saveGuidedSession: vi.fn().mockResolvedValue(saved), resetGuidedSession: vi.fn() };
    await mount(api);
    act(() => {
      state.save({ workflow: { lineup: { roles: { old: null } } } });
      state.save({ workflow: { lineup: { roles: { planner: 'new' } } } });
    });
    expect(state.session?.workflow.lineup.roles).toEqual({ planner: 'new' });
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(api.saveGuidedSession).toHaveBeenCalledWith({ workflow: { lineup: { roles: { old: null, planner: 'new' } } } });
  });

  test('persists one launch ID before returning, retains it on failure and reuses it on retry', async () => {
    const loaded = initialSession();
    const failure = new Error('disk unavailable');
    const save = vi.fn<(patch: GuidedSessionPatch) => Promise<GuidedSession>>()
      .mockRejectedValueOnce(failure)
      .mockImplementation(async (patch) => ({ ...loaded, workflow: { ...loaded.workflow, launch_request_id: patch.workflow!.launch_request_id! } }));
    const api = { getGuidedSession: vi.fn().mockResolvedValue(loaded), saveGuidedSession: save, resetGuidedSession: vi.fn() };
    await mount(api);
    await act(async () => { await expect(state.ensureLaunchRequestId()).rejects.toBe(failure); });
    expect(state.error).toBe(failure);
    expect(state.session?.workflow.launch_request_id).toBe('stable-launch-id');
    await act(async () => {
      const [first, second] = await Promise.all([state.ensureLaunchRequestId(), state.ensureLaunchRequestId()]);
      expect(first).toBe('stable-launch-id');
      expect(second).toBe(first);
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls.map(([patch]) => patch.workflow?.launch_request_id)).toEqual(['stable-launch-id', 'stable-launch-id']);
    expect(crypto.randomUUID).toHaveBeenCalledOnce();
    expect(state.error).toBeNull();
  });

  test('reset waits for an in-flight save and discards queued edits', async () => {
    const loaded = initialSession();
    const write = deferred<GuidedSession>();
    const resetResult = initialSession();
    const api = { getGuidedSession: vi.fn().mockResolvedValue(loaded), saveGuidedSession: vi.fn().mockReturnValue(write.promise), resetGuidedSession: vi.fn().mockResolvedValue(resetResult) };
    await mount(api);
    act(() => state.save({ brainstorm: { latest_rfc_draft: '# old' } }));
    await act(async () => { vi.advanceTimersByTime(400); });
    act(() => state.save({ active_stage: 'blueprint' }));
    let resetPromise!: Promise<GuidedSession>;
    act(() => { resetPromise = state.reset(); });
    expect(api.resetGuidedSession).not.toHaveBeenCalled();
    await act(async () => { write.resolve(loaded); await resetPromise; });
    expect(api.resetGuidedSession).toHaveBeenCalledOnce();
    expect(api.saveGuidedSession).toHaveBeenCalledOnce();
    expect(state.session).toEqual(resetResult);
  });

  test('keeps queued edits available for retry if reset fails', async () => {
    const loaded = initialSession();
    const edited = { ...loaded, brainstorm: { ...loaded.brainstorm, latest_rfc_draft: '# draft' } };
    const failure = new Error('reset failed');
    const api = { getGuidedSession: vi.fn().mockResolvedValue(loaded), saveGuidedSession: vi.fn().mockResolvedValue(edited), resetGuidedSession: vi.fn().mockRejectedValue(failure) };
    await mount(api);
    act(() => state.save({ brainstorm: { latest_rfc_draft: '# draft' } }));
    await act(async () => { await expect(state.reset()).rejects.toBe(failure); });
    expect(state.session?.brainstorm.latest_rfc_draft).toBe('# draft');
    await act(async () => { await state.flush(); });
    expect(api.saveGuidedSession).toHaveBeenCalledWith({ brainstorm: { latest_rfc_draft: '# draft' } });
    expect(state.error).toBeNull();
  });

  test('a failed in-flight save and failed reset preserve both older and newer edits', async () => {
    const loaded = initialSession();
    const write = deferred<GuidedSession>();
    const firstSaved = { ...loaded, brainstorm: { ...loaded.brainstorm, latest_rfc_draft: '# draft' } };
    const finalSaved = { ...firstSaved, active_stage: 'blueprint' as const };
    const resetFailure = new Error('reset failed');
    const api = {
      getGuidedSession: vi.fn().mockResolvedValue(loaded),
      saveGuidedSession: vi.fn().mockReturnValueOnce(write.promise).mockResolvedValueOnce(firstSaved).mockResolvedValueOnce(finalSaved),
      resetGuidedSession: vi.fn().mockRejectedValue(resetFailure),
    };
    await mount(api);
    act(() => state.save({ brainstorm: { latest_rfc_draft: '# draft' } }));
    await act(async () => { vi.advanceTimersByTime(400); });
    act(() => state.save({ active_stage: 'blueprint' }));
    let resetPromise!: Promise<GuidedSession>;
    act(() => { resetPromise = state.reset(); });
    await act(async () => { write.reject(new Error('write failed')); await expect(resetPromise).rejects.toBe(resetFailure); });
    expect(state.session).toMatchObject({ active_stage: 'blueprint', brainstorm: { latest_rfc_draft: '# draft' } });
    await act(async () => { await state.flush(); });
    expect(api.saveGuidedSession.mock.calls.slice(1)).toEqual([
      [{ brainstorm: { latest_rfc_draft: '# draft' } }],
      [{ active_stage: 'blueprint' }],
    ]);
    expect(state.session).toEqual(finalSaved);
  });

  test('an old client response cannot overwrite or save edits in a new client session', async () => {
    const old = initialSession();
    const next = { ...initialSession(), workspace_path: '/next' };
    const oldWrite = deferred<GuidedSession>();
    const oldApi = { getGuidedSession: vi.fn().mockResolvedValue(old), saveGuidedSession: vi.fn().mockReturnValue(oldWrite.promise), resetGuidedSession: vi.fn() };
    const nextSaved = { ...next, brainstorm: { ...next.brainstorm, latest_rfc_draft: '# next' } };
    const nextApi = { getGuidedSession: vi.fn().mockResolvedValue(next), saveGuidedSession: vi.fn().mockResolvedValue(nextSaved), resetGuidedSession: vi.fn() };
    const hook = await mount(oldApi);
    act(() => state.save({ brainstorm: { latest_rfc_draft: '# old' } }));
    await act(async () => { vi.advanceTimersByTime(400); });
    await hook.rerender(nextApi);
    expect(state.saving).toBe(false);
    act(() => state.save({ brainstorm: { latest_rfc_draft: '# next' } }));
    await act(async () => { oldWrite.resolve(old); });
    expect(state.session?.workspace_path).toBe('/next');
    expect(state.session?.brainstorm.latest_rfc_draft).toBe('# next');
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(oldApi.saveGuidedSession).toHaveBeenCalledTimes(1);
    expect(nextApi.saveGuidedSession).toHaveBeenCalledWith({ brainstorm: { latest_rfc_draft: '# next' } });
    expect(state.session).toEqual(nextSaved);
  });

  test('ignores the stale first load in Strict Mode', async () => {
    const oldLoad = deferred<GuidedSession>();
    const currentLoad = deferred<GuidedSession>();
    const api = { getGuidedSession: vi.fn().mockReturnValueOnce(oldLoad.promise).mockReturnValueOnce(currentLoad.promise), saveGuidedSession: vi.fn(), resetGuidedSession: vi.fn() };
    await mount(api, true);
    const current = { ...initialSession(), workspace_path: '/current' };
    await act(async () => { currentLoad.resolve(current); });
    await act(async () => { oldLoad.resolve({ ...initialSession(), workspace_path: '/stale' }); });
    expect(state.session?.workspace_path).toBe('/current');
  });

  test('creates a UUID-shaped ID from secure random bytes when randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(0) });
    expect(createLaunchRequestId()).toBe('00000000-0000-4000-8000-000000000000');
  });
});
