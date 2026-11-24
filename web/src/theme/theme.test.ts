import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, test, vi } from 'vitest';
import { readStoredTheme, THEME_STORAGE_KEY, ThemeProvider, useTheme } from './index';

describe('theme preferences', () => {
  test('defaults to dark theme safely in non-browser/default contexts', () => {
    expect(THEME_STORAGE_KEY).toBe('vibebaton.theme');
    expect(readStoredTheme()).toBe('dark');
  });

  test('survives React StrictMode cleanup and remount across multiple toggles', async () => {
    const storage = new Map<string, string>();
    const dataset: Record<string, string> = {};
    const flowClasses = new Set<string>(['react-flow', 'dark']);
    const flowEl = {
      classList: {
        remove: (...names: string[]) => names.forEach((n) => flowClasses.delete(n)),
        add: (...names: string[]) => names.forEach((n) => flowClasses.add(n)),
      },
    };
    const listeners = new Map<string, Set<EventListener>>();

    class TestNode {
      readonly nodeType = 1;
      readonly ownerDocument = null;
      readonly children: TestNode[] = [];
      readonly style = {};
      parentNode: TestNode | null = null;
      constructor(readonly tagName: string) {}
      addEventListener() {}
      appendChild(child: TestNode) { this.insertBefore(child, null); }
      insertBefore(child: TestNode, sibling: TestNode | null) {
        const index = sibling ? this.children.indexOf(sibling) : this.children.length;
        this.children.splice(index, 0, child);
        child.parentNode = this;
      }
      removeChild(child: TestNode) {
        this.children.splice(this.children.indexOf(child), 1);
        child.parentNode = null;
      }
    }

    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      documentElement: { dataset, offsetHeight: 0 },
      body: new TestNode('BODY'),
      getElementById: () => null,
      querySelectorAll: (sel: string) => (sel === '.react-flow' ? [flowEl] : []),
      addEventListener: (type: string, fn: EventListener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: EventListener) => {
        listeners.get(type)?.delete(fn);
      },
      createElement: (tag: string) => new TestNode(tag),
      createTextNode: (text: string) => new TestNode(text),
    });
    vi.stubGlobal('window', {
      HTMLIFrameElement: class HTMLIFrameElement {},
      location: { search: '' },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      matchMedia: () => ({ matches: true }),
    });

    let toggle!: () => void;
    let currentTheme = '';
    function Probe() {
      const ctx = useTheme();
      toggle = () => ctx.toggleTheme();
      currentTheme = ctx.theme;
      return null;
    }

    const container = new TestNode('DIV');
    const root = createRoot(container as unknown as HTMLElement);
    try {
      await act(async () => {
        root.render(
          createElement(StrictMode, null, createElement(ThemeProvider, null, createElement(Probe))),
        );
      });
      expect(currentTheme).toBe('dark');
      expect(dataset.theme).toBe('dark');

      await act(async () => toggle());
      expect(currentTheme).toBe('light');
      expect(dataset.theme).toBe('light');
      expect(storage.get(THEME_STORAGE_KEY)).toBe('light');
      expect(flowClasses.has('light')).toBe(true);

      await act(async () => toggle());
      expect(currentTheme).toBe('dark');
      expect(dataset.theme).toBe('dark');
      expect(storage.get(THEME_STORAGE_KEY)).toBe('dark');
      expect(flowClasses.has('dark')).toBe(true);
    } finally {
      try {
        act(() => root.unmount());
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });
});
