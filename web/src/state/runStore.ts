import { useSyncExternalStore } from 'react';
import type { BatonApiClient } from '../api/client';
import type { LiveRunSnapshot, RunListItem } from '../types/graph';

/** Snapshots and the event log keep only the latest events; the Studio says so where it shows them. */
export const LIVE_EVENT_LIMIT = 200;

export type RunAction = 'pause' | 'resume' | 'approve' | 'reject';
export type RunSyncStatus = 'synced' | 'loading' | 'error';
export type RunStoreClient = Pick<
  BatonApiClient,
  'streamUrl' | 'listRuns' | 'getRun' | 'getLatestRun' | 'controlRun' | 'resolveRun'
>;

export interface RunStoreState {
  /** Snapshot of the viewed run, with at most LIVE_EVENT_LIMIT events. */
  snapshot: LiveRunSnapshot | null;
  recentRuns: RunListItem[];
  /** The viewed run. */
  selectedRunId: string | null;
  /** The latest run the stream reported. */
  latestRunId: string | null;
  followLatest: boolean;
  syncStatus: RunSyncStatus;
  reconnecting: boolean;
  controlsBusy: boolean;
}

export interface RunStoreDeps {
  client: RunStoreClient;
  onError(error: unknown): void;
  /** Called with every snapshot the store adopts as the viewed run. */
  onSnapshot?(snapshot: LiveRunSnapshot): void;
  /** Called with every snapshot the stream sends, before the store decides whether to adopt it. */
  onStreamSnapshot?(snapshot: LiveRunSnapshot): void;
  createEventSource?(url: string): EventSource;
}

export type RunStore = ReturnType<typeof createRunStore>;

const initialState: RunStoreState = {
  snapshot: null,
  recentRuns: [],
  selectedRunId: null,
  latestRunId: null,
  followLatest: true,
  syncStatus: 'synced',
  reconnecting: false,
  controlsBusy: false,
};

function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRows(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRow);
}

export function isLiveSnapshot(value: unknown): value is LiveRunSnapshot {
  return isRow(value) && (value.run === null || isRow(value.run))
    && isRows(value.milestones) && isRows(value.tasks) && isRows(value.events) && isRows(value.quotas);
}

function withRecentEvents(snapshot: LiveRunSnapshot): LiveRunSnapshot {
  return { ...snapshot, events: snapshot.events.slice(-LIVE_EVENT_LIMIT) };
}

function runIdOf(snapshot: LiveRunSnapshot | null): string | null {
  return typeof snapshot?.run?.id === 'string' ? snapshot.run.id : null;
}

/** One run action: pause and resume control the run, approve and reject resolve its decision; then refresh. */
export async function performRunAction(
  client: Pick<RunStoreClient, 'controlRun' | 'resolveRun'>,
  refresh: () => Promise<void>,
  onError: (error: unknown) => void,
  runId: string,
  action: RunAction,
  note = '',
): Promise<boolean> {
  try {
    if (action === 'pause' || action === 'resume') {
      await client.controlRun(runId, action);
    } else {
      await client.resolveRun(runId, action, note);
    }
    await refresh();
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}

export function createRunStore({
  client,
  onError,
  onSnapshot,
  onStreamSnapshot,
  createEventSource = (url) => new EventSource(url),
}: RunStoreDeps) {
  let state = initialState;
  const listeners = new Set<() => void>();
  let latestStatus: string | null = null;
  let requestSeq = 0;
  let closeStream: (() => void) | null = null;

  function setState(patch: Partial<RunStoreState>) {
    const keys = Object.keys(patch) as (keyof RunStoreState)[];
    if (keys.every((key) => state[key] === patch[key])) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  function adopt(snapshot: LiveRunSnapshot, patch: Partial<RunStoreState> = {}) {
    setState({ ...patch, snapshot, syncStatus: 'synced' });
    onSnapshot?.(snapshot);
  }

  function refreshRecentRuns(isCurrent: () => boolean) {
    void client.listRuns().then((runs) => {
      if (isCurrent()) setState({ recentRuns: runs });
    }, () => {
      // History refresh failures do not block live updates.
    });
  }

  function connect() {
    disconnect();
    setState({ reconnecting: false });
    let active = true;
    const isActive = () => active;
    refreshRecentRuns(isActive);

    let source: EventSource;
    try {
      source = createEventSource(client.streamUrl());
    } catch (error) {
      onError(error);
      return;
    }

    function receiveSnapshot({ data }: MessageEvent<string>) {
      try {
        const parsed: unknown = JSON.parse(data);
        if (!isLiveSnapshot(parsed)) throw new Error('Invalid live run snapshot.');
        const snapshot = withRecentEvents(parsed);
        const streamRunId = runIdOf(snapshot);
        const streamStatus = typeof snapshot.run?.status === 'string' ? snapshot.run.status : null;
        onStreamSnapshot?.(snapshot);
        const previousLatestRunId = state.latestRunId;
        const previousLatestStatus = latestStatus;
        latestStatus = streamStatus;

        // The viewed run changes with the stream only while it follows the latest run.
        const { selectedRunId, followLatest } = state;
        if (selectedRunId === null || selectedRunId === streamRunId || (followLatest && selectedRunId === previousLatestRunId)) {
          adopt(snapshot, { latestRunId: streamRunId, selectedRunId: streamRunId, reconnecting: false });
        } else {
          setState({ latestRunId: streamRunId, reconnecting: false });
        }
        if (streamRunId !== previousLatestRunId || streamStatus !== previousLatestStatus) {
          refreshRecentRuns(isActive);
        }
      } catch (error) {
        onError(error);
      }
    }

    function receiveEvent({ data }: MessageEvent<string>) {
      try {
        const event: unknown = JSON.parse(data);
        if (!isRow(event)) throw new Error('Invalid live run event.');
        const eventRunId = typeof event.run_id === 'string' ? event.run_id : null;
        const current = state.snapshot;
        const currentRunId = runIdOf(current);
        const lastId = current?.events.at(-1)?.id;
        const appends = current !== null && currentRunId !== null
          && !(state.selectedRunId && state.selectedRunId !== currentRunId)
          && !(eventRunId && eventRunId !== currentRunId)
          && !(typeof event.id === 'number' && typeof lastId === 'number' && event.id <= lastId);
        setState(appends
          ? { snapshot: { ...current, events: [...current.events, event].slice(-LIVE_EVENT_LIMIT) }, reconnecting: false }
          : { reconnecting: false });
      } catch (error) {
        onError(error);
      }
    }

    source.addEventListener('snapshot', receiveSnapshot);
    source.addEventListener('event', receiveEvent);
    source.onopen = () => setState({ reconnecting: false });
    source.onerror = () => setState({ reconnecting: true });
    closeStream = () => {
      active = false;
      source.removeEventListener('snapshot', receiveSnapshot);
      source.removeEventListener('event', receiveEvent);
      source.onopen = null;
      source.onerror = null;
      source.close();
    };
  }

  function disconnect() {
    closeStream?.();
    closeStream = null;
  }

  function reset() {
    disconnect();
    requestSeq += 1;
    latestStatus = null;
    setState(initialState);
  }

  async function loadRun(runId: string, followLatest: boolean) {
    const req = ++requestSeq;
    setState({ selectedRunId: runId, followLatest, syncStatus: 'loading' });
    try {
      const snapshot = withRecentEvents(await client.getRun(runId));
      if (req !== requestSeq) return;
      adopt(snapshot);
      refreshRecentRuns(() => req === requestSeq);
    } catch (error) {
      if (req === requestSeq) {
        setState({ syncStatus: 'error' });
        onError(error);
      }
    }
  }

  /** The user opens a run from the run history. */
  async function selectRun(runId: string) {
    if (!runId) return;
    await loadRun(runId, runId === state.latestRunId);
  }

  /** The workbench launched or restored its own run. */
  async function followRun(runId: string) {
    if (!runId) return;
    await loadRun(runId, true);
  }

  async function backToLatest() {
    if (state.latestRunId) {
      await loadRun(state.latestRunId, true);
    } else {
      setState({ followLatest: true });
    }
  }

  async function refresh() {
    const req = ++requestSeq;
    try {
      const targetId = state.selectedRunId;
      const snapshot = withRecentEvents(targetId && targetId !== state.latestRunId
        ? await client.getRun(targetId)
        : await client.getLatestRun());
      if (req !== requestSeq) return;
      adopt(snapshot, targetId ? {} : { selectedRunId: runIdOf(snapshot) });
      refreshRecentRuns(() => req === requestSeq);
    } catch (error) {
      if (req === requestSeq) {
        if (state.selectedRunId && state.selectedRunId !== runIdOf(state.snapshot)) {
          setState({ syncStatus: 'error' });
        }
        onError(error);
      }
    }
  }

  async function changeRun(runId: string, action: RunAction, note = ''): Promise<boolean> {
    if (state.controlsBusy) return false;
    setState({ controlsBusy: true });
    try {
      return await performRunAction(client, refresh, onError, runId, action, note);
    } finally {
      setState({ controlsBusy: false });
    }
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    connect,
    disconnect,
    reset,
    selectRun,
    followRun,
    backToLatest,
    refresh,
    changeRun,
  };
}

export function useRunStore(store: RunStore): RunStoreState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
