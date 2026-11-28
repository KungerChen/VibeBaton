import { describe, expect, test } from 'vitest';
import appSource from '../App.tsx?raw';
import { DEFAULT_STUDIO_MODE, STUDIO_MODE_STORAGE_KEY, hasSavedStudioMode, loadStudioMode, saveStudioMode } from './studioMode';

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
  test('uses the documented storage key and opens the workbench when nothing is saved', () => {
    expect(STUDIO_MODE_STORAGE_KEY).toBe('vibebaton.studioMode');
    expect(DEFAULT_STUDIO_MODE).toBe('guided');
    expect(loadStudioMode(memoryStorage())).toBe('guided');
    expect(loadStudioMode(null)).toBe('guided');
    expect(loadStudioMode()).toBe('guided');
  });

  test('keeps a saved choice of either mode, so a refresh in Pro stays in Pro', () => {
    expect(loadStudioMode(memoryStorage({ [STUDIO_MODE_STORAGE_KEY]: 'pro' }))).toBe('pro');
    expect(loadStudioMode(memoryStorage({ [STUDIO_MODE_STORAGE_KEY]: 'guided' }))).toBe('guided');
    const storage = memoryStorage();
    saveStudioMode('pro', storage);
    expect(storage.getItem(STUDIO_MODE_STORAGE_KEY)).toBe('pro');
    expect(loadStudioMode(storage)).toBe('pro');
    saveStudioMode('guided', storage);
    expect(loadStudioMode(storage)).toBe('guided');
  });

  test('opens the workbench for unknown values and blocked storage', () => {
    for (const value of ['GUIDED', 'PRO', 'lab', '']) {
      expect(loadStudioMode(memoryStorage({ [STUDIO_MODE_STORAGE_KEY]: value })), value).toBe('guided');
    }
    expect(loadStudioMode(throwingStorage())).toBe('guided');
    expect(() => saveStudioMode('guided', throwingStorage())).not.toThrow();
  });

  test('a shared recipe link still opens in Pro, without replacing the saved choice', () => {
    expect(appSource).toContain(
      "useState<StudioMode>(() => (typeof window !== 'undefined' && window.location.hash.startsWith('#recipe=') ? 'pro' : loadStudioMode()))",
    );
  });

  test('without a local server a first visit shows the Pro canvas, unless a mode was chosen before', () => {
    expect(hasSavedStudioMode(memoryStorage())).toBe(false);
    expect(hasSavedStudioMode(memoryStorage({ [STUDIO_MODE_STORAGE_KEY]: 'lab' }))).toBe(false);
    expect(hasSavedStudioMode(null)).toBe(false);
    expect(hasSavedStudioMode(throwingStorage())).toBe(false);
    expect(hasSavedStudioMode(memoryStorage({ [STUDIO_MODE_STORAGE_KEY]: 'guided' }))).toBe(true);
    expect(hasSavedStudioMode(memoryStorage({ [STUDIO_MODE_STORAGE_KEY]: 'pro' }))).toBe(true);
    // The workbench needs the local server; the standalone demo only has the canvas to show.
    expect(appSource).toContain("if (nextMode === 'demo' && !hasSavedStudioMode()) setStudioMode('pro');");
  });
});
