import { describe, expect, test } from 'vitest';
import { readStoredTheme, THEME_STORAGE_KEY } from './index';

describe('theme preferences', () => {
  test('defaults to dark theme safely in non-browser/default contexts', () => {
    expect(THEME_STORAGE_KEY).toBe('vibebaton.theme');
    expect(readStoredTheme()).toBe('dark');
  });
});
