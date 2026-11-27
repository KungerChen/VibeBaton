import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import appSource from '../App.tsx?raw';
import { BatonApiClient } from '../api/client';
import { starter_2tier } from '../data/presets';
import { MESSAGES } from '../i18n/messages';
import { HeaderBar } from './HeaderBar';
import { LiveRunPanel } from './inspector/LiveRunPanel';
import { RightInspector } from './RightInspector';

const sources = import.meta.glob<string>(['../**/*.ts', '../**/*.tsx', '../**/*.css'], { query: '?raw', import: 'default', eager: true });
const source = (name: string) => Object.entries(sources).find(([path]) => path.endsWith(`/${name}`))?.[1] ?? '';
const label = MESSAGES.en.inspector.startRealRun;

// A minimal host: React needs only these node methods to mount the buttons and dispatch a click.
function mountHost() {
  type Listener = (event: { type: string; target: TestNode; button: number }) => void;
  const listeners = new Map<string, Listener>();
  const document = {
    createElement: (tag: string) => new TestNode(tag),
    createElementNS: (_namespace: string, tag: string) => new TestNode(tag),
    createTextNode: (text: string) => new TestNode('#text', text),
    addEventListener() {},
    removeEventListener() {},
  };
  class TestNode {
    readonly nodeType: number;
    readonly ownerDocument = document;
    readonly children: TestNode[] = [];
    readonly style = {};
    parentNode: TestNode | null = null;
    constructor(readonly tagName: string, public textContent = '') { this.nodeType = tagName === '#text' ? 3 : 1; }
    addEventListener(type: string, callback: Listener, capture: boolean) { if (!capture) listeners.set(type, callback); }
    removeEventListener() {}
    setAttribute() {}
    removeAttribute() {}
    appendChild(child: TestNode) { this.insertBefore(child, null); }
    insertBefore(child: TestNode, sibling: TestNode | null) {
      this.children.splice(sibling ? this.children.indexOf(sibling) : this.children.length, 0, child);
      child.parentNode = this;
    }
    removeChild(child: TestNode) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
    get text(): string { return this.textContent + this.children.map((child) => child.text).join(''); }
    find(text: string): TestNode | undefined {
      if (this.tagName === 'button' && this.text.trim() === text) return this;
      for (const child of this.children) {
        const match = child.find(text);
        if (match) return match;
      }
      return undefined;
    }
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', { HTMLIFrameElement: class {}, localStorage: { getItem: () => 'en' } });
  const container = new TestNode('div');
  const root = createRoot(container as unknown as HTMLElement);
  return {
    async render(element: ReturnType<typeof createElement>) { await act(async () => root.render(element)); },
    async clickButton(text: string) {
      const button = container.find(text);
      if (!button) throw new Error(`Missing button ${text}: ${container.text}`);
      await act(async () => listeners.get('click')?.({ type: 'click', target: button, button: 0 }));
    },
    unmount: () => act(() => root.unmount()),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('the former Start Real Run buttons', () => {
  test('all three open the workbench through the one handler App provides', () => {
    expect(appSource).toContain("const openLaunchBar = () => onStudioModeChange('guided');");
    expect(appSource.match(/onOpenStartRun=\{[^}]*\}/g)).toEqual([
      "onOpenStartRun={studioMode === 'pro' && mode === 'local' ? openLaunchBar : undefined}",
      "onOpenStartRun={mode === 'local' ? openLaunchBar : undefined}",
    ]);
    // RightInspector hands the same handler to the live run panel.
    expect(source('RightInspector.tsx')).toContain('onOpenStartRun={onOpenStartRun}');
  });

  test('the budget link opens the Pro sidebar with the first-run guide out of the way', () => {
    const handler = /onOpenBudget=\{\(\) => \{([\s\S]*?)\n\s*\}\}/.exec(appSource)?.[1] ?? '';
    for (const call of ["onStudioModeChange('pro');", "setPane('sidebar');", 'setGuideOpen(false);']) {
      expect(handler).toContain(call);
    }
  });

  test('the old start dialog is gone from the source tree', () => {
    const remaining = Object.entries(sources)
      .filter(([path, text]) => !path.endsWith('/launchEntries.test.ts') && text.includes('StartRunModal'))
      .map(([path]) => path);
    expect(remaining).toEqual([]);
    expect(source('App.tsx')).toContain('GuidedWorkbench');
  });

  test('each button calls the handler and names where it goes', async () => {
    expect(label).toBe('Go to Guided mode to start a run');
    expect(MESSAGES.zh.inspector.startRealRun).toBe('去引导模式开始运行');
    const client = new BatonApiClient();
    const onOpenStartRun = vi.fn();
    const host = mountHost();
    try {
      await host.render(createElement(HeaderBar, { mode: 'local', graphName: 'Starter', onOpenStartRun }));
      await host.clickButton(label);
      await host.render(createElement(RightInspector, {
        mode: 'local', client, graph: starter_2tier, selectedNodeId: null, selectedEdgeId: null,
        onUpdateNode: vi.fn(), onUpdateEdge: vi.fn(), trace: [], stepIndex: 0, onJumpToStep: vi.fn(), onToast: vi.fn(),
        onSelectRunId: vi.fn(), onOpenStartRun,
      }));
      await host.clickButton(label);
      await host.render(createElement(LiveRunPanel, { client, onToast: vi.fn(), visible: true, onSelectRunId: vi.fn(), onOpenStartRun }));
      await host.clickButton(label);
      expect(onOpenStartRun).toHaveBeenCalledTimes(3);
    } finally {
      host.unmount();
    }
  });

  test('stay hidden without a local server, and the live panel has no start button of its own', () => {
    expect(renderToStaticMarkup(createElement(HeaderBar, { mode: 'demo', graphName: 'Starter', onOpenStartRun: vi.fn() })))
      .not.toContain(label);
    expect(renderToStaticMarkup(createElement(LiveRunPanel, {
      client: new BatonApiClient(), onToast: vi.fn(), visible: true, onSelectRunId: vi.fn(),
    }))).not.toContain(label);
  });
});
