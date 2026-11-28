export type StudioMode = 'guided' | 'pro';

export const STUDIO_MODE_STORAGE_KEY = 'vibebaton.studioMode';
export const DEFAULT_STUDIO_MODE: StudioMode = 'guided';

function getStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  return typeof window === 'undefined' ? null : window.localStorage;
}

export function loadStudioMode(storage?: Storage | null): StudioMode {
  try {
    // Only a saved Pro choice leaves the default; anything else opens the workbench.
    return getStorage(storage)?.getItem(STUDIO_MODE_STORAGE_KEY) === 'pro' ? 'pro' : DEFAULT_STUDIO_MODE;
  } catch {
    return DEFAULT_STUDIO_MODE;
  }
}

/** Whether the user has chosen a mode before; a first visit has not. */
export function hasSavedStudioMode(storage?: Storage | null): boolean {
  try {
    const saved = getStorage(storage)?.getItem(STUDIO_MODE_STORAGE_KEY);
    return saved === 'guided' || saved === 'pro';
  } catch {
    return false;
  }
}

export function saveStudioMode(mode: StudioMode, storage?: Storage | null): void {
  try {
    getStorage(storage)?.setItem(STUDIO_MODE_STORAGE_KEY, mode);
  } catch {
    // The chosen mode still applies for this session when storage is blocked.
  }
}
