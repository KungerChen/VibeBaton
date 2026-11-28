import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { LiveRunSnapshot, RunListItem } from '../types/graph';
import { createRunStore, useRunStore, type RunStore, type RunStoreClient, type RunStoreState } from './runStore';

type Listener = (event: MessageEvent<string>) => void;

class FakeEventSource {
  readonly listeners = new Map<string, Set<Listener>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  close() { this.closed = true; }

  emit(type: 'snapshot' | 'event', payload: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(payload) } as MessageEvent<string>);
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function snapshot(id: string, status = 'RUNNING', events: Record<string, unknown>[] = []): LiveRunSnapshot {
  return { run: { id, status }, milestones: [], tasks: [], events, quotas: [{ provider: id }] };
}

function event(id: number, runId?: string): Record<string, unknown> {
  return runId === undefined ? { id, kind: 'role_invoked' } : { id, run_id: runId, kind: 'role_invoked' };
}

const runsList: RunListItem[] = [{
  id: 'run-1', status: 'RUNNING', mode: 'interactive', created_at: 1, updated_at: 2, finished_at: null,
  elapsed_sec: 1, passed_tasks: 0, total_tasks: 1, passed_milestones: 0, total_milestones: 1,
}];

function setup() {
  const sources: FakeEventSource[] = [];
  const client = {
    streamUrl: vi.fn(() => '/api/runs/stream'),
    listRuns: vi.fn(async () => runsList),
    getRun: vi.fn(async (id: string) => snapshot(id)),
    getLatestRun: vi.fn(async () => snapshot('run-latest')),
    controlRun: vi.fn(async (runId: string, action: 'pause' | 'resume') => ({ run_id: runId, status: action as string })),
    resolveRun: vi.fn(async (runId: string, decision: 'approve' | 'reject') => ({ run_id: runId, decision, daemon_pid: null })),
  } satisfies RunStoreClient;
  const onError = vi.fn<(error: unknown) => void>();
  const onSnapshot = vi.fn<(value: LiveRunSnapshot) => void>();
  const onStreamSnapshot = vi.fn<(value: LiveRunSnapshot) => void>();
  const store = createRunStore({
    client,
    onError,
    onSnapshot,
    onStreamSnapshot,
    createEventSource: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source as unknown as EventSource;
    },
  });
  const source = () => {
    const current = sources.at(-1);
    if (!current) throw new Error('No event source was opened');
    return current;
  };
  return { store, client, onError, onSnapshot, onStreamSnapshot, sources, source };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('runStore stream', () => {
  test('adopts the first stream snapshot with the latest 200 events and hands it to the app', async () => {
    const { store, onSnapshot, onStreamSnapshot, source, client } = setup();
    store.connect();
    expect(client.streamUrl).toHaveBeenCalledOnce();
    expect(source().url).toBe('/api/runs/stream');
    const events = Array.from({ length: 250 }, (_, index) => event(index + 1));
    source().emit('snapshot', snapshot('run-1', 'RUNNING', events));

    const state = store.getState();
    expect(state.selectedRunId).toBe('run-1');
    expect(state.latestRunId).toBe('run-1');
    expect(state.followLatest).toBe(true);
    expect(state.syncStatus).toBe('synced');
    expect(state.snapshot?.events).toHaveLength(200);
    expect(state.snapshot?.events[0]).toEqual(event(51));
    expect(state.snapshot?.events.at(-1)).toEqual(event(250));
    expect(onStreamSnapshot).toHaveBeenCalledOnce();
    expect(onStreamSnapshot.mock.calls[0][0].events).toHaveLength(200);
    expect(onSnapshot).toHaveBeenCalledWith(state.snapshot);
    await flush();
    expect(store.getState().recentRuns).toEqual(runsList);
  });

  test('appends a stream event to the viewed run once by id and skips events of other runs', () => {
    const { store, source } = setup();
    store.connect();
    source().emit('snapshot', snapshot('run-1', 'RUNNING', [event(1, 'run-1'), event(2, 'run-1')]));

    source().emit('event', event(3, 'run-1'));
    source().emit('event', event(3, 'run-1'));
    source().emit('event', event(2, 'run-1'));
    source().emit('event', event(4, 'run-2'));
    source().emit('event', event(5));

    expect(store.getState().snapshot?.events.map(({ id }) => id)).toEqual([1, 2, 3, 5]);
  });

  test('keeps only the latest 200 events when single events arrive', () => {
    const { store, source } = setup();
    store.connect();
    source().emit('snapshot', snapshot('run-1', 'RUNNING', Array.from({ length: 200 }, (_, index) => event(index + 1, 'run-1'))));
    source().emit('event', event(201, 'run-1'));

    const events = store.getState().snapshot?.events ?? [];
    expect(events).toHaveLength(200);
    expect(events[0]).toEqual(event(2, 'run-1'));
    expect(events.at(-1)).toEqual(event(201, 'run-1'));
  });

  test('reports a malformed snapshot and keeps the viewed run', () => {
    const { store, source, onError } = setup();
    store.connect();
    source().emit('snapshot', snapshot('run-1'));
    source().emit('snapshot', { run: 'nope' });

    expect(onError).toHaveBeenCalledOnce();
    expect(store.getState().snapshot?.run?.id).toBe('run-1');
  });

  test('refreshes the recent runs when the latest run or its status changes', async () => {
    const { store, source, client } = setup();
    store.connect();
    await flush();
    expect(client.listRuns).toHaveBeenCalledTimes(1);
    source().emit('snapshot', snapshot('run-1'));
    source().emit('snapshot', snapshot('run-1'));
    expect(client.listRuns).toHaveBeenCalledTimes(2);
    source().emit('snapshot', snapshot('run-1', 'PAUSED'));
    expect(client.listRuns).toHaveBeenCalledTimes(3);
    source().emit('snapshot', snapshot('run-2', 'PAUSED'));
    expect(client.listRuns).toHaveBeenCalledTimes(4);
  });

  test('sets reconnecting on an error and clears it on open or on the next message', () => {
    const { store, source } = setup();
    store.connect();
    expect(store.getState().reconnecting).toBe(false);
    source().onerror?.();
    expect(store.getState().reconnecting).toBe(true);
    source().emit('snapshot', snapshot('run-1'));
    expect(store.getState().reconnecting).toBe(false);
    source().onerror?.();
    source().onopen?.();
    expect(store.getState().reconnecting).toBe(false);
    source().onerror?.();
    source().emit('event', event(1, 'run-1'));
    expect(store.getState().reconnecting).toBe(false);
  });

  test('stops receiving after disconnect, opens only one event source, and reset clears the state', () => {
    const { store, source, sources } = setup();
    store.connect();
    source().emit('snapshot', snapshot('run-1', 'RUNNING', [event(1, 'run-1')]));
    const before = store.getState();
    store.disconnect();

    expect(source().closed).toBe(true);
    source().emit('snapshot', snapshot('run-2'));
    source().emit('event', event(2, 'run-1'));
    source().onerror?.();
    expect(store.getState()).toBe(before);
    expect(sources).toHaveLength(1);

    store.reset();
    expect(store.getState()).toEqual({
      snapshot: null, recentRuns: [], selectedRunId: null, latestRunId: null, followLatest: true,
      syncStatus: 'synced', reconnecting: false, controlsBusy: false,
    } satisfies RunStoreState);
  });

  test('notifies subscribers only when the state changes', () => {
    const { store, source } = setup();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.connect();
    source().onopen?.();
    expect(listener).not.toHaveBeenCalled();
    source().onerror?.();
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    source().onopen?.();
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe('runStore follow latest', () => {
  test('moves to a newer run while following the latest run', () => {
    const { store, source } = setup();
    store.connect();
    source().emit('snapshot', snapshot('run-1'));
    source().emit('snapshot', snapshot('run-2'));

    expect(store.getState().selectedRunId).toBe('run-2');
    expect(store.getState().snapshot?.run?.id).toBe('run-2');
  });

  test('opening an older run turns following off so other runs only move the latest run', async () => {
    const { store, source, client } = setup();
    store.connect();
    source().emit('snapshot', snapshot('run-2'));
    await store.selectRun('run-1');

    expect(client.getRun).toHaveBeenCalledWith('run-1');
    expect(store.getState()).toMatchObject({ selectedRunId: 'run-1', latestRunId: 'run-2', followLatest: false });
    expect(store.getState().snapshot?.run?.id).toBe('run-1');

    source().emit('snapshot', snapshot('run-3'));
    source().emit('event', event(9, 'run-3'));
    source().emit('snapshot', snapshot('run-4'));
    expect(store.getState()).toMatchObject({ selectedRunId: 'run-1', latestRunId: 'run-4', followLatest: false });
    expect(store.getState().snapshot?.run?.id).toBe('run-1');
    expect(store.getState().snapshot?.events).toEqual([]);

    // The viewed run's own updates still reach it.
    source().emit('snapshot', snapshot('run-1', 'PAUSED'));
    expect(store.getState().snapshot?.run?.status).toBe('PAUSED');
    expect(store.getState().followLatest).toBe(false);
  });

  test('back to latest returns to the latest run and follows again', async () => {
    const { store, source, client } = setup();
    store.connect();
    source().emit('snapshot', snapshot('run-2'));
    await store.selectRun('run-1');
    source().emit('snapshot', snapshot('run-3'));

    await store.backToLatest();
    expect(client.getRun).toHaveBeenLastCalledWith('run-3');
    expect(store.getState()).toMatchObject({ selectedRunId: 'run-3', latestRunId: 'run-3', followLatest: true });
    expect(store.getState().snapshot?.run?.id).toBe('run-3');

    source().emit('snapshot', snapshot('run-4'));
    expect(store.getState().selectedRunId).toBe('run-4');
  });

  test('selecting the latest run keeps following on', async () => {
    const { store, source } = setup();
    store.connect();
    source().emit('snapshot', snapshot('run-2'));
    await store.selectRun('run-2');
    expect(store.getState().followLatest).toBe(true);
    source().emit('snapshot', snapshot('run-3'));
    expect(store.getState().selectedRunId).toBe('run-3');
  });

  test('a just-launched run is not replaced by the previous latest run before the stream reports it', async () => {
    const { store, source, client } = setup();
    store.connect();
    source().emit('snapshot', snapshot('run-old'));
    await store.selectRun('run-older');
    expect(store.getState().followLatest).toBe(false);

    const launched = deferred<LiveRunSnapshot>();
    client.getRun.mockReturnValueOnce(launched.promise);
    const following = store.followRun('run-new');
    expect(store.getState()).toMatchObject({ selectedRunId: 'run-new', followLatest: true, syncStatus: 'loading' });

    source().emit('snapshot', snapshot('run-old', 'PAUSED'));
    expect(store.getState().selectedRunId).toBe('run-new');
    expect(store.getState().snapshot?.run?.id).toBe('run-older');
    launched.resolve(snapshot('run-new', 'PLANNING'));
    await following;
    expect(store.getState().snapshot?.run?.id).toBe('run-new');
    expect(store.getState().syncStatus).toBe('synced');

    source().emit('snapshot', snapshot('run-old', 'COMPLETED'));
    expect(store.getState().snapshot?.run?.id).toBe('run-new');
    source().emit('snapshot', snapshot('run-new', 'RUNNING'));
    expect(store.getState().snapshot?.run?.status).toBe('RUNNING');
    // Following stays on, so the next run the stream reports is followed.
    source().emit('snapshot', snapshot('run-next'));
    expect(store.getState().selectedRunId).toBe('run-next');
  });

  test('ignores events while another run is being loaded', async () => {
    const { store, source, client } = setup();
    store.connect();
    source().emit('snapshot', snapshot('run-1', 'RUNNING', [event(1, 'run-1')]));
    const pending = deferred<LiveRunSnapshot>();
    client.getRun.mockReturnValueOnce(pending.promise);
    const selecting = store.selectRun('run-0');
    source().emit('event', event(2, 'run-1'));
    expect(store.getState().snapshot?.events.map(({ id }) => id)).toEqual([1]);
    pending.resolve(snapshot('run-0'));
    await selecting;
  });
});

describe('runStore requests', () => {
  test('drops a stale run response', async () => {
    const { store, client, onSnapshot } = setup();
    const first = deferred<LiveRunSnapshot>();
    const second = deferred<LiveRunSnapshot>();
    client.getRun.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const selectingA = store.selectRun('run-a');
    const selectingB = store.selectRun('run-b');
    second.resolve(snapshot('run-b'));
    await selectingB;
    first.resolve(snapshot('run-a'));
    await selectingA;

    expect(store.getState().selectedRunId).toBe('run-b');
    expect(store.getState().snapshot?.run?.id).toBe('run-b');
    expect(onSnapshot).toHaveBeenCalledOnce();
  });

  test('trims a loaded run to the latest 200 events and refreshes the recent runs', async () => {
    const { store, client } = setup();
    client.getRun.mockResolvedValueOnce(snapshot('run-a', 'COMPLETED', Array.from({ length: 205 }, (_, index) => event(index))));
    await store.selectRun('run-a');
    await flush();
    expect(store.getState().snapshot?.events).toHaveLength(200);
    expect(store.getState().recentRuns).toEqual(runsList);
  });

  test('a failed run request sets the error status and reports the error', async () => {
    const { store, client, onError } = setup();
    const failure = new Error('Run not found');
    client.getRun.mockRejectedValueOnce(failure);
    await store.selectRun('run-missing');

    expect(store.getState().selectedRunId).toBe('run-missing');
    expect(store.getState().syncStatus).toBe('error');
    expect(onError).toHaveBeenCalledWith(failure);
  });

  test('ignores an empty run id', async () => {
    const { store, client } = setup();
    await store.selectRun('');
    expect(client.getRun).not.toHaveBeenCalled();
    expect(store.getState().selectedRunId).toBeNull();
  });

  test('refresh reads the latest run while following it and the selected run otherwise', async () => {
    const { store, source, client } = setup();
    await store.refresh();
    expect(client.getLatestRun).toHaveBeenCalledOnce();
    expect(store.getState().selectedRunId).toBe('run-latest');

    store.connect();
    source().emit('snapshot', snapshot('run-latest'));
    await store.refresh();
    expect(client.getLatestRun).toHaveBeenCalledTimes(2);
    expect(client.getRun).not.toHaveBeenCalled();

    await store.selectRun('run-1');
    client.getRun.mockClear();
    await store.refresh();
    expect(client.getRun).toHaveBeenCalledWith('run-1');
    expect(store.getState().selectedRunId).toBe('run-1');
  });

  test('a failed refresh of a run that is not shown yet sets the error status', async () => {
    const { store, client, onError } = setup();
    const pending = deferred<LiveRunSnapshot>();
    client.getRun.mockReturnValueOnce(pending.promise);
    void store.selectRun('run-1');
    client.getRun.mockRejectedValueOnce(new Error('offline'));
    await store.refresh();
    expect(store.getState().syncStatus).toBe('error');
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('runStore controls', () => {
  test('pause and resume use controlRun, approve and reject use resolveRun with the note, then refresh', async () => {
    const { store, client } = setup();
    await expect(store.changeRun('run-1', 'pause')).resolves.toBe(true);
    await expect(store.changeRun('run-1', 'resume')).resolves.toBe(true);
    await expect(store.changeRun('run-1', 'approve', 'Looks good')).resolves.toBe(true);
    await expect(store.changeRun('run-1', 'reject', 'Needs tests')).resolves.toBe(true);

    expect(client.controlRun.mock.calls).toEqual([['run-1', 'pause'], ['run-1', 'resume']]);
    expect(client.resolveRun.mock.calls).toEqual([['run-1', 'approve', 'Looks good'], ['run-1', 'reject', 'Needs tests']]);
    expect(client.getLatestRun).toHaveBeenCalledTimes(1);
    expect(client.getRun).toHaveBeenCalledTimes(3);
    expect(store.getState().controlsBusy).toBe(false);
  });

  test('refuses a second action while one is in flight', async () => {
    const { store, client } = setup();
    const pending = deferred<{ run_id: string; status: string }>();
    client.controlRun.mockReturnValueOnce(pending.promise);
    const first = store.changeRun('run-1', 'pause');
    expect(store.getState().controlsBusy).toBe(true);
    await expect(store.changeRun('run-1', 'resume')).resolves.toBe(false);
    expect(client.controlRun).toHaveBeenCalledOnce();
    pending.resolve({ run_id: 'run-1', status: 'PAUSED' });
    await expect(first).resolves.toBe(true);
    expect(store.getState().controlsBusy).toBe(false);
  });

  test('a failed action reports the error, returns false and clears busy', async () => {
    const { store, client, onError } = setup();
    const failure = new Error('Run is not paused');
    client.resolveRun.mockRejectedValueOnce(failure);
    await expect(store.changeRun('run-1', 'approve')).resolves.toBe(false);
    expect(client.resolveRun).toHaveBeenCalledWith('run-1', 'approve', '');
    expect(onError).toHaveBeenCalledWith(failure);
    expect(store.getState().controlsBusy).toBe(false);
    expect(client.getLatestRun).not.toHaveBeenCalled();
  });
});

describe('useRunStore', () => {
  let root: ReturnType<typeof createRoot> | undefined;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { HTMLIFrameElement: class HTMLIFrameElement {} });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    vi.unstubAllGlobals();
  });

  test('renders the store state and follows its updates', async () => {
    const { store, source } = setup();
    let seen: RunStoreState | undefined;
    function Probe({ value }: { value: RunStore }) { seen = useRunStore(value); return null; }
    const container = { nodeType: 1, tagName: 'DIV', ownerDocument: null, addEventListener() {} };
    root = createRoot(container as unknown as HTMLElement);
    await act(async () => root!.render(createElement(Probe, { value: store })));
    expect(seen?.snapshot).toBeNull();

    store.connect();
    await act(async () => source().emit('snapshot', snapshot('run-1')));
    expect(seen?.selectedRunId).toBe('run-1');
    expect(seen).toBe(store.getState());
  });
});

describe('one stream for the Studio', () => {
  const sources = import.meta.glob<string>(['../**/*.ts', '../**/*.tsx'], { query: '?raw', import: 'default', eager: true });

  test('only the run store opens an event stream', () => {
    const openers = Object.entries(sources)
      .filter(([path, text]) => !path.endsWith('.test.ts') && text.includes('new EventSource'))
      .map(([path]) => path);
    expect(Object.keys(sources)).toContain('../App.tsx');
    expect(Object.keys(sources)).toContain('../components/inspector/LiveRunPanel.tsx');
    expect(openers).toEqual(['./runStore.ts']);
  });
});
