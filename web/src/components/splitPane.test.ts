import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  clampPaneWidth,
  PANE_WIDTHS_STORAGE_KEY,
  readPaneWidths,
  writePaneWidths,
  type PaneWidths,
} from './splitPane';

const DEFAULT_WIDTHS: PaneWidths = { sidebar: 288, inspector: 376 };

function createStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() { return entries.size; },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => Array.from(entries.keys())[index] ?? null,
    removeItem: (key) => { entries.delete(key); },
    setItem: (key, value) => { entries.set(key, value); },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('clampPaneWidth', () => {
  test.each([
    [100, 220],
    [314.5, 314.5],
    [600, 440],
  ])('clamps %s to %s within the sidebar limits', (width, expected) => {
    expect(clampPaneWidth(width, 220, 440)).toBe(expected);
  });
});

describe('readPaneWidths', () => {
  test('uses defaults when storage or the saved entry is missing', () => {
    expect(readPaneWidths()).toEqual(DEFAULT_WIDTHS);
    expect(readPaneWidths(createStorage())).toEqual(DEFAULT_WIDTHS);
  });

  test.each([
    [{ sidebar: 180, inspector: 900 }, { sidebar: 220, inspector: 720 }],
    [{ sidebar: 520, inspector: 235 }, { sidebar: 440, inspector: 320 }],
  ])('clamps saved widths to each pane’s limits', (widths, expected) => {
    const storage = createStorage();
    storage.setItem(PANE_WIDTHS_STORAGE_KEY, JSON.stringify(widths));

    expect(readPaneWidths(storage)).toEqual(expected);
  });

  test.each(['{"sidebar":', 'null', '72'])('uses defaults for unusable saved data (%s)', (raw) => {
    const storage = createStorage();
    storage.setItem(PANE_WIDTHS_STORAGE_KEY, raw);

    expect(readPaneWidths(storage)).toEqual(DEFAULT_WIDTHS);
  });

  test.each([
    ['{"sidebar":1e999,"inspector":512}', { sidebar: 288, inspector: 512 }],
    ['{"sidebar":306,"inspector":-1e999}', { sidebar: 306, inspector: 376 }],
    ['{"sidebar":"306","inspector":512}', { sidebar: 288, inspector: 512 }],
    ['{"sidebar":306}', { sidebar: 306, inspector: 376 }],
  ])('defaults invalid or missing widths per pane (%s)', (raw, expected) => {
    const storage = createStorage();
    storage.setItem(PANE_WIDTHS_STORAGE_KEY, raw);

    expect(readPaneWidths(storage)).toEqual(expected);
  });
});

describe('pane width persistence', () => {
  test('round-trips widths under the shared storage key', () => {
    const storage = createStorage();
    const widths = { sidebar: 344.5, inspector: 570 };

    writePaneWidths(widths, storage);

    expect(storage.getItem('vibebaton.paneWidths')).toBe(JSON.stringify(widths));
    expect(readPaneWidths(storage)).toEqual(widths);
  });

  test('uses browser storage by default and respects explicit null storage', () => {
    const storage = createStorage();
    vi.stubGlobal('window', { localStorage: storage });
    const widths = { sidebar: 305, inspector: 508 };

    writePaneWidths(widths);
    writePaneWidths(DEFAULT_WIDTHS, null);

    expect(readPaneWidths()).toEqual(widths);
    expect(readPaneWidths(null)).toEqual(DEFAULT_WIDTHS);
  });

  test('uses defaults when accessing local storage throws a SecurityError', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new DOMException('Storage access blocked', 'SecurityError');
      },
    });

    expect(readPaneWidths()).toEqual(DEFAULT_WIDTHS);
    expect(() => writePaneWidths(DEFAULT_WIDTHS)).not.toThrow();
  });

  test('keeps the saved widths when a write exceeds quota', () => {
    const storage = createStorage();
    const previous = { sidebar: 305, inspector: 508 };
    writePaneWidths(previous, storage);
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
    });

    expect(() => writePaneWidths(DEFAULT_WIDTHS, storage)).not.toThrow();
    expect(readPaneWidths(storage)).toEqual(previous);
  });
});
