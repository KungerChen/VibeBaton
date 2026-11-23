export const DEFAULT_SIDEBAR_WIDTH = 288;
export const MIN_SIDEBAR_WIDTH = 220;
export const MAX_SIDEBAR_WIDTH = 440;
export const DEFAULT_INSPECTOR_WIDTH = 376;
export const MIN_INSPECTOR_WIDTH = 320;
export const MAX_INSPECTOR_WIDTH = 720;
export const PANE_WIDTHS_STORAGE_KEY = 'vibebaton.paneWidths';
export const KEYBOARD_STEP_PX = 16;

export interface PaneWidths {
  sidebar: number;
  inspector: number;
}

export function clampPaneWidth(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  return typeof window === 'undefined' ? null : window.localStorage;
}

function readWidth(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? clampPaneWidth(value, min, max)
    : fallback;
}

export function readPaneWidths(storage?: Storage | null): PaneWidths {
  let saved: Partial<Record<keyof PaneWidths, unknown>> = {};
  try {
    const raw = getStorage(storage)?.getItem(PANE_WIDTHS_STORAGE_KEY);
    const parsed: unknown = raw == null ? null : JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') saved = parsed;
  } catch {
    // Keep the defaults when storage is unavailable or its contents are malformed.
  }

  return {
    sidebar: readWidth(saved.sidebar, DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH),
    inspector: readWidth(saved.inspector, DEFAULT_INSPECTOR_WIDTH, MIN_INSPECTOR_WIDTH, MAX_INSPECTOR_WIDTH),
  };
}

export function writePaneWidths(widths: PaneWidths, storage?: Storage | null): void {
  try {
    getStorage(storage)?.setItem(PANE_WIDTHS_STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // Resizing remains available when the browser blocks storage writes.
  }
}
