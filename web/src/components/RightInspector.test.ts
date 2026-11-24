import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { BatonApiClient } from '../api/client';
import { starter_2tier } from '../data/presets';
import { I18nProvider } from '../i18n';
import { MESSAGES } from '../i18n/messages';
import { RightInspector } from './RightInspector';

describe('RightInspector guidance and auto-tab switching', () => {
  test('renders empty-state helper hint and launch/trace quick actions in GraphDetails', () => {
    const markup = renderToStaticMarkup(createElement(RightInspector, {
      mode: 'local',
      client: new BatonApiClient(),
      graph: starter_2tier,
      selectedNodeId: null,
      selectedEdgeId: null,
      onUpdateNode: vi.fn(),
      onUpdateEdge: vi.fn(),
      trace: [],
      stepIndex: 0,
      onJumpToStep: vi.fn(),
      onToast: vi.fn(),
      onOpenStartRun: vi.fn(),
    }));

    expect(markup).toContain(MESSAGES.en.inspector.emptyHint);
    expect(markup).toContain('Open Trace &amp; Live Run');
    expect(markup).toContain(MESSAGES.en.inspector.startRealRun);
  });

  test('auto-switches back to Inspector tab when a node is selected while viewing Trace', async () => {
    type Listener = (event: { type: string; target: TestNode; button: number }) => void;
    const listeners = new Map<string, Listener>();
    const documentObj = {
      createElement: (tag: string) => new TestNode(tag),
      createElementNS: (_ns: string, tag: string) => new TestNode(tag),
      createTextNode: (text: string) => new TestNode('#text', text),
      addEventListener() {},
    };
    class TestNode {
      readonly nodeType: number;
      readonly ownerDocument = documentObj;
      readonly children: TestNode[] = [];
      readonly style = {};
      readonly attrs = new Map<string, string>();
      parentNode: TestNode | null = null;
      constructor(readonly tagName: string, public textContent = '') {
        this.nodeType = tagName === '#text' ? 3 : 1;
      }
      addEventListener(type: string, cb: Listener, capture: boolean) {
        if (!capture) listeners.set(type, cb);
      }
      setAttribute(k: string, v: string) { this.attrs.set(k, v); }
      removeAttribute(k: string) { this.attrs.delete(k); }
      appendChild(c: TestNode) { this.insertBefore(c, null); }
      insertBefore(c: TestNode, s: TestNode | null) {
        const idx = s ? this.children.indexOf(s) : this.children.length;
        this.children.splice(idx, 0, c);
        c.parentNode = this;
      }
      removeChild(c: TestNode) {
        this.children.splice(this.children.indexOf(c), 1);
        c.parentNode = null;
      }
      get text(): string { return this.textContent + this.children.map((c) => c.text).join(''); }
      find(tag: string, pred?: (n: TestNode) => boolean): TestNode | undefined {
        if (this.tagName === tag && (!pred || pred(this))) return this;
        for (const c of this.children) {
          const m = c.find(tag, pred);
          if (m) return m;
        }
        return undefined;
      }
    }

    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', {
      HTMLIFrameElement: class HTMLIFrameElement {},
      localStorage: { getItem: () => 'en' },
    });

    const container = new TestNode('DIV');
    const root = createRoot(container as unknown as HTMLElement);
    const client = new BatonApiClient();
    const baseProps = {
      mode: 'demo' as const,
      client,
      graph: starter_2tier,
      selectedEdgeId: null,
      onUpdateNode: vi.fn(),
      onUpdateEdge: vi.fn(),
      trace: [],
      stepIndex: 0,
      onJumpToStep: vi.fn(),
      onToast: vi.fn(),
    };

    try {
      await act(async () => {
        root.render(createElement(I18nProvider, {
          children: createElement(RightInspector, { ...baseProps, selectedNodeId: null }),
        }));
      });

      const traceTab = container.find('button', (el) => el.attrs.get('role') === 'tab' && el.text.includes('Trace'));
      expect(traceTab).toBeDefined();
      await act(async () => listeners.get('click')?.({ type: 'click', target: traceTab!, button: 0 }));
      expect(String(traceTab!.attrs.get('aria-selected'))).toBe('true');

      // Selecting a node (e.g. Quick Start Step 3) must auto-switch back to Inspector.
      await act(async () => {
        root.render(createElement(I18nProvider, {
          children: createElement(RightInspector, { ...baseProps, selectedNodeId: starter_2tier.nodes[0].id }),
        }));
      });

      const inspectorTab = container.find('button', (el) => el.attrs.get('role') === 'tab' && el.text.includes('Inspector'));
      expect(String(inspectorTab?.attrs.get('aria-selected'))).toBe('true');
      expect(String(traceTab?.attrs.get('aria-selected'))).toBe('false');
    } finally {
      try {
        act(() => root.unmount());
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });
});
