import { describe, expect, test } from 'vitest';
import { DEFAULT_STUDIO_MODE, STUDIO_MODE_STORAGE_KEY, loadStudioMode, saveStudioMode } from './studioMode';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(key); },
    setItem: (key, value) => { data.set(key, String(value)); },
  };
}

function throwingStorage(): Storage {
  const fail = () => { throw new Error('SecurityError'); };
  return { length: 0, clear: fail, getItem: fail, key: fail, removeItem: fail, setItem: fail };
}

describe('studioMode store', () => {
  test('uses the documented storage key and defaults to pro', () => {
    expect(STUDIO_MODE_STORAGE_KEY).toBe('vibebaton.studioMode');
    expect(DEFAULT_STUDIO_MODE).toBe('pro');
    expect(loadStudioMode(memoryStorage())).toBe('pro');
    expect(loadStudioMode(null)).toBe('pro');
    expect(loadStudioMode()).toBe('pro');
  });

  test('round-trips both modes through storage', () => {
    const storage = memoryStorage();
    saveStudioMode('guided', storage);
    expect(storage.getItem(STUDIO_MODE_STORAGE_KEY)).toBe('guided');
    expect(loadStudioMode(storage)).toBe('guided');
    saveStudioMode('pro', storage);
    expect(loadStudioMode(storage)).toBe('pro');
  });

  test('falls back to pro for unknown values and blocked storage', () => {
    expect(loadStudioMode(memoryStorage({ [STUDIO_MODE_STORAGE_KEY]: 'GUIDED' }))).toBe('pro');
    expect(loadStudioMode(throwingStorage())).toBe('pro');
    expect(() => saveStudioMode('guided', throwingStorage())).not.toThrow();
  });
});
