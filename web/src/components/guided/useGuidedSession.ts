import { useCallback, useEffect, useRef, useState } from 'react';
import type { BatonApiClient, GuidedSession, GuidedSessionPatch } from '../../api/client';

export type GuidedSessionApi = Pick<BatonApiClient, 'getGuidedSession' | 'saveGuidedSession' | 'resetGuidedSession'>;

export interface GuidedSessionState {
  session: GuidedSession | null;
  loading: boolean;
  saving: boolean;
  error: unknown | null;
  /** Queue a partial server merge and update the local view immediately. */
  save(patch: GuidedSessionPatch): void;
  /** Wait for all queued writes; call before a workspace switch or launch. */
  flush(): Promise<GuidedSession>;
  /** Persist and reuse one key until the session explicitly starts a new launch intent. */
  ensureLaunchRequestId(): Promise<string>;
  /** Discard queued edits and reset after any in-flight write settles. */
  reset(): Promise<GuidedSession>;
}

type ObjectValue = Record<string, unknown>;
const isObject = (value: unknown): value is ObjectValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isLineupMap = (path: string) => path === 'workflow.lineup.roles' || path === 'workflow.lineup.model_overrides';

// Session patches recursively merge, except that an empty lineup map clears it.
// When composing patches, retain null tombstones until the server receives them.
function mergeObjects(base: ObjectValue, patch: ObjectValue, path = '', composing = false): ObjectValue {
  if (isLineupMap(path) && Object.keys(patch).length === 0) return {};
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const childPath = path ? `${path}.${key}` : key;
    if (isLineupMap(path) && value === null && !composing) delete result[key];
    else if (isObject(value)) result[key] = mergeObjects(isObject(result[key]) ? result[key] as ObjectValue : {}, value, childPath, composing);
    else result[key] = value;
  }
  return result;
}

function lineupMaps(patch: GuidedSessionPatch): (Record<string, string | null> | undefined)[] {
  return [patch.workflow?.lineup?.roles, patch.workflow?.lineup?.model_overrides];
}

function enqueue(queue: GuidedSessionPatch[], patch: GuidedSessionPatch): void {
  const previous = queue[queue.length - 1];
  const before = previous && lineupMaps(previous);
  const after = lineupMaps(patch);
  // Clearing a map and adding entries requires two writes: a nonempty map merges on the server.
  const needsSeparateWrite = before?.some((map, index) => map !== undefined && Object.keys(map).length === 0
    && after[index] !== undefined && Object.keys(after[index]!).length > 0);
  if (!previous || needsSeparateWrite) queue.push(structuredClone(patch));
  else queue[queue.length - 1] = mergeObjects(previous, patch, '', true) as GuidedSessionPatch;
}

export function createLaunchRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues !== 'function') throw new Error('Secure random IDs are unavailable');
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Keep api stable for the lifetime of a workspace; flush before changing workspaces. */
export function useGuidedSession(api: GuidedSessionApi, debounceMs = 400): GuidedSessionState {
  const [session, setSession] = useState<GuidedSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const sessionRef = useRef<GuidedSession | null>(null);
  const queue = useRef<GuidedSessionPatch[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef<Promise<GuidedSession> | null>(null);
  const launchKeyPromise = useRef<Promise<string> | null>(null);
  const mounted = useRef(false);
  const resetting = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    let current = true;
    const currentGeneration = ++generation.current;
    mounted.current = true;
    sessionRef.current = null;
    setSession(null);
    setLoading(true);
    setSaving(false);
    setError(null);
    void api.getGuidedSession().then((loaded) => {
      if (!current) return;
      sessionRef.current = loaded;
      setSession(loaded);
    }).catch((reason: unknown) => {
      if (current) setError(reason);
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => {
      current = false;
      mounted.current = false;
      if (generation.current === currentGeneration) generation.current += 1;
      clearTimeout(timer.current);
      queue.current = [];
      sessionRef.current = null;
      inFlight.current = null;
      launchKeyPromise.current = null;
      resetting.current = false;
    };
  }, [api]);

  const flush = useCallback(async (): Promise<GuidedSession> => {
    const currentGeneration = generation.current;
    clearTimeout(timer.current);
    timer.current = undefined;
    if (resetting.current) throw new Error('Session reset is in progress');
    if (inFlight.current) {
      await inFlight.current;
      if (generation.current !== currentGeneration || resetting.current) throw new Error('Session changed during save');
      if (queue.current.length) return flush();
      if (!sessionRef.current) throw new Error('Session is not loaded');
      return sessionRef.current;
    }
    if (!sessionRef.current) throw new Error('Session is not loaded');
    if (!queue.current.length) return sessionRef.current;
    if (mounted.current) setSaving(true);
    const operation = (async () => {
      while (queue.current.length) {
        const patch = queue.current.shift()!;
        let saved: GuidedSession;
        try {
          saved = await api.saveGuidedSession(patch);
        } catch (reason) {
          if (generation.current === currentGeneration) queue.current.unshift(patch);
          throw reason;
        }
        if (generation.current !== currentGeneration) throw new Error('Session changed during save');
        const view = queue.current.reduce<GuidedSession>(
          (current, queued) => mergeObjects(current, queued) as GuidedSession, saved,
        );
        sessionRef.current = view;
        if (mounted.current) setSession(view);
      }
      return sessionRef.current!;
    })();
    inFlight.current = operation;
    try {
      const saved = await operation;
      if (mounted.current && generation.current === currentGeneration) setError(null);
      return saved;
    } catch (reason) {
      if (mounted.current && generation.current === currentGeneration) setError(reason);
      throw reason;
    } finally {
      if (inFlight.current === operation) inFlight.current = null;
      if (mounted.current && generation.current === currentGeneration && !resetting.current) setSaving(false);
    }
  }, [api]);

  const save = useCallback((patch: GuidedSessionPatch) => {
    if (!sessionRef.current || resetting.current) throw new Error('Session is not ready to save');
    enqueue(queue.current, patch);
    const view = mergeObjects(sessionRef.current, patch) as GuidedSession;
    sessionRef.current = view;
    setSession(view);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush().catch(() => {}); }, Math.max(0, debounceMs));
  }, [debounceMs, flush]);

  const ensureLaunchRequestId = useCallback((): Promise<string> => {
    if (launchKeyPromise.current) return launchKeyPromise.current;
    const operation = (async () => {
      const currentGeneration = generation.current;
      if (!sessionRef.current) throw new Error('Session is not loaded');
      const id = sessionRef.current.workflow.launch_request_id || createLaunchRequestId();
      if (!sessionRef.current.workflow.launch_request_id) save({ workflow: { launch_request_id: id } });
      const saved = await flush();
      if (generation.current !== currentGeneration || resetting.current) throw new Error('Session changed during launch preparation');
      if (saved.workflow.launch_request_id !== id) throw new Error('Launch request ID was not saved');
      return id;
    })();
    launchKeyPromise.current = operation;
    void operation.finally(() => {
      if (launchKeyPromise.current === operation) launchKeyPromise.current = null;
    }).catch(() => {});
    return operation;
  }, [flush, save]);

  const reset = useCallback(async (): Promise<GuidedSession> => {
    if (resetting.current) throw new Error('Session reset is already in progress');
    const currentGeneration = generation.current;
    resetting.current = true;
    clearTimeout(timer.current);
    const discarded = queue.current;
    let recoverable = discarded;
    queue.current = [];
    if (mounted.current) setSaving(true);
    try {
      // A started write must finish before reset, or it could restore the discarded draft.
      if (inFlight.current) await inFlight.current.catch(() => {});
      if (generation.current !== currentGeneration) throw new Error('Session changed during reset');
      recoverable = [...queue.current, ...discarded];
      queue.current = [];
      const fresh = await api.resetGuidedSession();
      if (generation.current !== currentGeneration) throw new Error('Session changed during reset');
      sessionRef.current = fresh;
      if (mounted.current) { setSession(fresh); setError(null); }
      return fresh;
    } catch (reason) {
      if (generation.current === currentGeneration) {
        queue.current = [...queue.current, ...recoverable];
        if (sessionRef.current) {
          const view = queue.current.reduce<GuidedSession>(
            (current, patch) => mergeObjects(current, patch) as GuidedSession, sessionRef.current,
          );
          sessionRef.current = view;
          if (mounted.current) setSession(view);
        }
        if (mounted.current) setError(reason);
      }
      throw reason;
    } finally {
      if (generation.current === currentGeneration) {
        resetting.current = false;
        if (mounted.current) setSaving(false);
      }
    }
  }, [api]);

  return { session, loading, saving, error, save, flush, ensureLaunchRequestId, reset };
}
