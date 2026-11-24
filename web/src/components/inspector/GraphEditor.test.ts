import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { BatonApiClient } from '../../api/client';
import { demoProviderHealth } from '../../data/demoConfig';
import { I18nProvider } from '../../i18n';
import type { WorkflowNode } from '../../types/graph';
import { NodeEditor } from './GraphEditor';

function createDomHarness(locale: 'en' | 'zh' = 'en') {
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
    value = '';
    validity = { valid: true };

    constructor(readonly tagName: string, public textContent = '') {
      this.nodeType = tagName === '#text' ? 3 : 1;
    }

    addEventListener(type: string, cb: Listener, capture: boolean) {
      if (!capture) listeners.set(type, cb);
    }
    setAttribute(name: string, val: string) { this.attrs.set(name, val); }
    removeAttribute(name: string) { this.attrs.delete(name); }
    appendChild(child: TestNode) { this.insertBefore(child, null); }
    insertBefore(child: TestNode, sibling: TestNode | null) {
      const idx = sibling ? this.children.indexOf(sibling) : this.children.length;
      this.children.splice(idx, 0, child);
      child.parentNode = this;
    }
    removeChild(child: TestNode) {
      this.children.splice(this.children.indexOf(child), 1);
      child.parentNode = null;
    }
    get text(): string {
      return this.textContent + this.children.map((c) => c.text).join('');
    }
    find(tag: string, predicate?: (n: TestNode) => boolean): TestNode | undefined {
      if (this.tagName === tag && (!predicate || predicate(this))) return this;
      for (const child of this.children) {
        const match = child.find(tag, predicate);
        if (match) return match;
      }
      return undefined;
    }
  }

  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', {
    HTMLIFrameElement: class HTMLIFrameElement {},
    localStorage: { getItem: () => locale },
  });

  const container = new TestNode('DIV');
  return {
    container,
    click(target: TestNode) {
      const listener = listeners.get('click');
      if (!listener) throw new Error('Missing click listener');
      listener({ type: 'click', target, button: 0 });
    },
  };
}

describe('GraphEditor DSH hints and DoctorControl stability', () => {
  test.each(['en', 'zh'] as const)('demoProviderHealth DSH hint in %s contains DSH and zero opencode', (locale) => {
    const health = demoProviderHealth('dsh_opencode', locale);
    expect(health.install_hint).toContain('DSH');
    expect(health.install_hint).not.toMatch(/opencode/i);
    if (locale === 'zh') {
      expect(health.install_hint).toMatch(/\p{Script=Han}/u);
    }
  });

  test.each(['en', 'zh'] as const)('NodeEditor renders localized DSH hint without leaking OPENCODE_API_KEY in %s', async (locale) => {
    const client = new BatonApiClient();
    vi.spyOn(client, 'doctorRole').mockResolvedValueOnce({
      provider: 'dsh_opencode',
      ok: false,
      detail: 'Missing in standalone demo.',
      install_hint: 'Install the DeepSeek Harness CLI and set OPENCODE_API_KEY.',
      latency_ms: 12,
    });

    const node: WorkflowNode = {
      id: 'worker_1',
      type: 'worker_node',
      label: 'Worker',
      role: 'bulk_worker',
      position: { x: 0, y: 0 },
      config: { provider: 'dsh_opencode', model: 'deepseek-v4.1-flash@max' },
    };

    const { container, click } = createDomHarness(locale);
    const root = createRoot(container as unknown as HTMLElement);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, {
          children: createElement(NodeEditor, {
            node,
            mode: 'demo',
            client,
            providerListId: 'providers',
            onUpdateNode: () => {},
            onToast: () => {},
            onDoctorResult: () => {},
          }),
        }));
      });

      const doctorBtn = container.find('button', (el) => el.text.includes('Doctor') || el.text.includes('诊断'));
      expect(doctorBtn).toBeDefined();
      await act(async () => click(doctorBtn!));

      expect(container.text).toContain('DSH');
      expect(container.text).not.toMatch(/opencode/i);
      if (locale === 'zh') {
        expect(container.text).toMatch(/\p{Script=Han}/u);
      }
    } finally {
      try {
        act(() => root.unmount());
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  test('does not remount the 5s Doctor button DOM element when model or provider changes', async () => {
    const client = new BatonApiClient();
    vi.spyOn(client, 'doctorRole').mockResolvedValue({
      provider: 'dsh_opencode',
      ok: true,
      detail: 'Ready',
      install_hint: '',
      latency_ms: 10,
    });

    const baseNode: WorkflowNode = {
      id: 'worker_1',
      type: 'worker_node',
      label: 'Worker',
      role: 'bulk_worker',
      position: { x: 0, y: 0 },
      config: { provider: 'dsh_opencode', model: 'deepseek-v4.1-flash@low' },
    };

    const { container, click } = createDomHarness('en');
    const root = createRoot(container as unknown as HTMLElement);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, {
          children: createElement(NodeEditor, {
            node: baseNode,
            mode: 'local',
            client,
            providerListId: 'providers',
            onUpdateNode: () => {},
            onToast: () => {},
            onDoctorResult: () => {},
          }),
        }));
      });

      const btnBefore = container.find('button', (el) => el.text.includes('5s Doctor'));
      expect(btnBefore).toBeDefined();

      // Update model prop (simulating blur commit right before mouseup click).
      await act(async () => {
        root.render(createElement(I18nProvider, {
          children: createElement(NodeEditor, {
            node: { ...baseNode, config: { provider: 'dsh_opencode', model: 'deepseek-v4.1-flash@max' } },
            mode: 'local',
            client,
            providerListId: 'providers',
            onUpdateNode: () => {},
            onToast: () => {},
            onDoctorResult: () => {},
          }),
        }));
      });

      const btnAfter = container.find('button', (el) => el.text.includes('5s Doctor'));
      expect(btnAfter).toBe(btnBefore);
      await act(async () => click(btnAfter!));
      expect(client.doctorRole).toHaveBeenCalledWith(expect.objectContaining({
        model: 'deepseek-v4.1-flash@max',
      }));
    } finally {
      try {
        act(() => root.unmount());
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  test('renders canvas-immediate helper note in static markup', () => {
    const node: WorkflowNode = {
      id: 'worker_1',
      type: 'worker_node',
      label: 'Worker',
      role: 'bulk_worker',
      position: { x: 0, y: 0 },
      config: { provider: 'dsh_opencode', model: 'deepseek-v4.1-flash@max' },
    };
    const markup = renderToStaticMarkup(createElement(NodeEditor, {
      node,
      mode: 'local',
      client: new BatonApiClient(),
      providerListId: 'providers',
      onUpdateNode: () => {},
      onToast: () => {},
      onDoctorResult: () => {},
    }));
    expect(markup).toContain('Field edits update the canvas recipe immediately.');
  });
});
