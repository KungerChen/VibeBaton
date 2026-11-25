export type StudioMode = 'guided' | 'pro';

export const STUDIO_MODE_STORAGE_KEY = 'vibebaton.studioMode';
export const DEFAULT_STUDIO_MODE: StudioMode = 'pro';

function getStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  return typeof window === 'undefined' ? null : window.localStorage;
}

export function loadStudioMode(storage?: Storage | null): StudioMode {
  try {
    return getStorage(storage)?.getItem(STUDIO_MODE_STORAGE_KEY) === 'guided' ? 'guided' : DEFAULT_STUDIO_MODE;
  } catch {
    return DEFAULT_STUDIO_MODE;
  }
}

export function saveStudioMode(mode: StudioMode, storage?: Storage | null): void {
  try {
    getStorage(storage)?.setItem(STUDIO_MODE_STORAGE_KEY, mode);
  } catch {
    // The chosen mode still applies for this session when storage is blocked.
  }
}
