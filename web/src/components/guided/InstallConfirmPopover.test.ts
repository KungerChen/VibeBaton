import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CliDriver } from '../../api/client';
import { I18nProvider } from '../../i18n';
import { MESSAGES } from '../../i18n/messages';
import { Button } from '../ui/button';
import { InstallConfirmPopover, type InstallConfirmPopoverProps } from './InstallConfirmPopover';

vi.mock('../ui/button', () => ({
  Button: vi.fn(({ children, variant: _variant, size: _size, ...props }: ComponentProps<typeof Button>) =>
    createElement('button', props, children)),
}));

const driver: CliDriver = {
  id: 'dsh',
  name: 'DSH',
  tier: 'official',
  binary: 'dsh',
  summary_en: 'DSH runs headless sessions.',
  summary_zh: 'DSH 运行无头会话。',
  prereq: ['node'],
  install_cmd: ['npm', 'install', '-g', '@deepseek-ai/dsh'],
  login_cmd: ['dsh'],
  official_url: 'https://www.npmjs.com/package/@deepseek-ai/dsh',
  command_template: ['dsh', '--patch', 'dsh-headless-opencode-go.patch.yml'],
  version_cmd: ['dsh', '--version'],
  provider_ids: ['dsh_opencode'],
  env_keys: ['OPENCODE_API_KEY'],
  auth_check_cmd: null,
};

const command = 'npm install -g @deepseek-ai/dsh';

function baseProps(overrides: Partial<InstallConfirmPopoverProps> = {}): InstallConfirmPopoverProps {
  return {
    driver,
    open: true,
    busy: false,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

function renderMarkup(locale: 'en' | 'zh', overrides: Partial<InstallConfirmPopoverProps> = {}): string {
  vi.stubGlobal('window', { localStorage: { getItem: () => locale } });
  return renderToStaticMarkup(createElement(I18nProvider, {
    children: createElement(InstallConfirmPopover, baseProps(overrides)),
  }));
}

type Listener = (event: { key?: string; target?: TestNode }) => void;

interface FakeDocument {
  documentElement: { lang: string };
  title: string;
  createElement(tag: string): TestNode;
  createElementNS(namespace: string, tag: string): TestNode;
  createTextNode(text: string): TestNode;
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
}

class TestNode {
  readonly nodeType: number;
  readonly children: TestNode[] = [];
  readonly style: Record<string, string | number> = {};
  readonly attrs = new Map<string, string>();
  parentNode: TestNode | null = null;
  private classValue = '';

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
    public textContent = '',
  ) {
    this.nodeType = tagName === '#text' ? 3 : 1;
  }

  get className() {
    return this.classValue;
  }

  set className(value: string) {
    this.classValue = value;
    this.attrs.set('class', value);
  }

  get nodeValue() {
    return this.textContent;
  }

  set nodeValue(value: string) {
    this.textContent = value;
  }

  addEventListener() {}

  removeEventListener() {}

  setAttribute(name: string, value: string) {
    this.attrs.set(name, String(value));
    if (name === 'class') this.classValue = String(value);
  }

  removeAttribute(name: string) {
    this.attrs.delete(name);
    if (name === 'class') this.classValue = '';
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  appendChild(child: TestNode) {
    this.insertBefore(child, null);
  }

  insertBefore(child: TestNode, sibling: TestNode | null) {
    const index = sibling ? this.children.indexOf(sibling) : this.children.length;
    this.children.splice(index, 0, child);
    child.parentNode = this;
  }

  removeChild(child: TestNode) {
    this.children.splice(this.children.indexOf(child), 1);
    child.parentNode = null;
  }

  contains(node: TestNode): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }

  find(tag: string, predicate?: (node: TestNode) => boolean): TestNode | undefined {
    if (this.tagName === tag && (!predicate || predicate(this))) return this;
    for (const child of this.children) {
      const match = child.find(tag, predicate);
      if (match) return match;
    }
    return undefined;
  }
}

let root: Root | undefined;

async function mount(
  locale: 'en' | 'zh',
  props: InstallConfirmPopoverProps,
): Promise<{ container: TestNode; dispatch(type: string, event: { key?: string; target?: TestNode }): void }> {
  const listeners = new Map<string, Set<Listener>>();
  const documentObj: FakeDocument = {
    documentElement: { lang: '' },
    title: '',
    createElement: (tag) => new TestNode(tag, documentObj),
    createElementNS: (_namespace, tag) => new TestNode(tag, documentObj),
    createTextNode: (text) => new TestNode('#text', documentObj, text),
    addEventListener(type, listener) {
      const bucket = listeners.get(type) ?? new Set<Listener>();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };

  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', {
    HTMLIFrameElement: class HTMLIFrameElement {},
    localStorage: { getItem: () => locale },
  });
  vi.stubGlobal('document', documentObj);

  const container = new TestNode('DIV', documentObj);
  const renderer = createRoot(container as unknown as HTMLElement);
  root = renderer;
  await act(async () => {
    renderer.render(createElement(I18nProvider, {
      children: createElement(InstallConfirmPopover, props),
    }));
  });

  return {
    container,
    dispatch(type, event) {
      const bucket = listeners.get(type);
      if (!bucket?.size) throw new Error(`Missing ${type} listener`);
      for (const listener of bucket) listener(event);
    },
  };
}

afterEach(() => {
  try {
    if (root) act(() => root?.unmount());
  } finally {
    root = undefined;
    vi.mocked(Button).mockClear();
    vi.unstubAllGlobals();
  }
});

describe('InstallConfirmPopover', () => {
  test.each(['en', 'zh'] as const)('renders the exact registry command and localized copy in %s', (locale) => {
    const copy = MESSAGES[locale].guided.m3.installConfirm;
    const html = renderMarkup(locale);

    expect(html).toContain('role="dialog"');
    expect(html).toMatch(/aria-labelledby="[^"]+"/);
    expect(html).toMatch(/aria-describedby="[^"]+"/);
    expect(html).toContain(copy.title);
    expect(html).toContain(copy.description);
    expect(html).toContain(copy.command);
    expect(html).toContain(copy.confirm);
    expect(html).toContain(copy.cancel);
    expect(html).toContain(`<code>${command}</code>`);
  });

  test('renders nothing and exposes no action while closed', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const html = renderMarkup('en', { open: false, onConfirm, onCancel });

    expect(html).toBe('');
    expect(vi.mocked(Button)).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  test('opening the confirmation starts nothing', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderMarkup('en', { onConfirm, onCancel });

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  test('runs only after Confirm is clicked and never after Cancel', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const copy = MESSAGES.en.guided.m3.installConfirm;
    renderMarkup('en', { onConfirm, onCancel });

    const buttons = vi.mocked(Button).mock.calls.map(([props]) => props);
    const confirm = buttons.find((props) => props.children === copy.confirm);
    const cancel = buttons.find((props) => props.children === copy.cancel);
    expect(confirm).toBeDefined();
    expect(cancel).toBeDefined();

    confirm?.onClick?.({} as never);
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();

    cancel?.onClick?.({} as never);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  test('shows a parent-supplied failure as text without turning it into markup', () => {
    const html = renderMarkup('en', { error: 'EACCES <denied>' });
    const copy = MESSAGES.en.guided.m3.installConfirm;

    expect(html).toContain('role="alert"');
    expect(html).toContain(copy.failed);
    expect(html).toContain('EACCES &lt;denied&gt;');
    expect(html).not.toContain('EACCES <denied>');
  });

  test('shows progress, marks the dialog busy, and disables confirmation while installing', () => {
    const copy = MESSAGES.zh.guided.m3.installConfirm;
    const html = renderMarkup('zh', { busy: true });

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(copy.installing);
    const buttons = vi.mocked(Button).mock.calls.map(([props]) => props);
    const confirm = buttons.find((props) => props.disabled === true);
    expect(confirm?.children).toBe(copy.installing);
  });

  test('Escape and outside clicks cancel, while clicks inside the popover do not', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const harness = await mount('en', baseProps({ onConfirm, onCancel }));

    act(() => {
      harness.dispatch('keydown', { key: 'Escape' });
    });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();

    const title = harness.container.find('h2');
    expect(title).toBeDefined();
    act(() => {
      harness.dispatch('pointerdown', { target: title });
    });
    expect(onCancel).toHaveBeenCalledOnce();

    act(() => {
      harness.dispatch('pointerdown', { target: new TestNode('DIV', harness.container.ownerDocument) });
    });
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
