import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RunTaskDetail } from '../../api/client';
import { MESSAGES, type Locale } from '../../i18n/messages';
import {
  NodeDetailDrawer,
  formatElapsed,
  summarizeDetail,
  type NodeDetailDrawerProps,
} from './NodeDetailDrawer';

const RUN_ID = 'run-42';
const TASK_ID = 'M1/T1';

const detail: RunTaskDetail = {
  run_id: RUN_ID,
  task_id: TASK_ID,
  milestone_id: 'M1',
  title: 'Add task detail endpoint',
  tier: 'routine',
  status: 'PASSED',
  summary: 'The Plan DAG output is ready and the Unit Test suite passed.',
  attempts: 1,
  test_status: 'passed',
  provider: 'claude_sub',
  model: 'sonnet',
  elapsed_sec: 90,
  cost_usd: 0.04,
  changed_files: ['src/app.py', 'web/src/App.tsx'],
  review_verdict: 'PASS',
};

const documentObj = {
  createElement: (tag: string) => new TestNode(tag),
  createElementNS: (_namespace: string, tag: string) => new TestNode(tag),
  createTextNode: (text: string) => new TestNode('#text', text),
  addEventListener() {},
};

class TestNode {
  readonly nodeType: number;
  readonly ownerDocument = documentObj;
  readonly children: TestNode[] = [];
  readonly style: Record<string, string | number> = {};
  readonly attrs = new Map<string, string>();
  parentNode: TestNode | null = null;
  private classValue = '';

  constructor(readonly tagName: string, public textContent = '') {
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

  remove() {
    this.parentNode?.removeChild(this);
  }

  get text(): string {
    return this.textContent + this.children.map((child) => child.text).join('');
  }

  find(tag: string, predicate?: (node: TestNode) => boolean): TestNode | undefined {
    if (this.tagName === tag && (!predicate || predicate(this))) return this;
    for (const child of this.children) {
      const match = child.find(tag, predicate);
      if (match) return match;
    }
    return undefined;
  }

  findByAttr(name: string, value: string): TestNode | undefined {
    if (this.attrs.get(name) === value) return this;
    for (const child of this.children) {
      const match = child.findByAttr(name, value);
      if (match) return match;
    }
    return undefined;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function field(container: TestNode, name: string): string | undefined {
  return container.findByAttr('data-field', name)?.text;
}

let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', {
    HTMLIFrameElement: class HTMLIFrameElement {},
    localStorage: { getItem: () => 'en' },
  });
});

afterEach(() => {
  try {
    act(() => root?.unmount());
  } finally {
    root = undefined;
    vi.unstubAllGlobals();
  }
});

async function renderDrawer(overrides: Partial<NodeDetailDrawerProps> = {}) {
  const container = new TestNode('DIV');
  const renderer = createRoot(container as unknown as HTMLElement);
  root = renderer;
  const props: NodeDetailDrawerProps = {
    runId: RUN_ID,
    taskId: TASK_ID,
    onClose: vi.fn(),
    locale: 'en',
    ...overrides,
  };
  await act(async () => {
    renderer.render(createElement(NodeDetailDrawer, props));
  });
  return { container, props };
}

describe('formatElapsed', () => {
  test.each<[number, Locale, string]>([
    [12.5, 'en', '12.5s'],
    [12.5, 'zh', '12.5秒'],
    [90, 'en', '1m 30s'],
    [90, 'zh', '1分30秒'],
    [3661, 'en', '1h 1m'],
    [-4, 'zh', '0秒'],
  ])('formats %s seconds in %s as %s', (sec, locale, expected) => {
    expect(formatElapsed(sec, locale)).toBe(expected);
  });
});

describe('summarizeDetail', () => {
  test('formats the full task payload with a deterministic file order and two-decimal cost', () => {
    expect(summarizeDetail(detail, 'en')).toEqual({
      status: 'PASSED',
      summary: detail.summary,
      model: 'claude_sub / sonnet',
      elapsed: '1m 30s',
      cost: '$0.04',
      tests: 'passed',
      changedFiles: ['src/app.py', 'web/src/App.tsx'],
      verdict: 'PASS',
    });
    expect(summarizeDetail({ ...detail, provider: 'dsh_opencode', model: 'flash' }, 'en').model)
      .toBe('DSH / flash');
  });

  test('keeps two-decimal USD in both locales and renders readable fallbacks', () => {
    const sparse: RunTaskDetail = {
      ...detail,
      provider: null,
      model: null,
      test_status: 'not_run',
      cost_usd: 1234.5,
      changed_files: [],
      review_verdict: null,
    };

    expect(summarizeDetail(sparse, 'en')).toMatchObject({
      model: '—',
      cost: '$1,234.50',
      tests: 'not run',
      changedFiles: [],
      verdict: '—',
    });
    expect(summarizeDetail({ ...sparse, cost_usd: 0.04 }, 'zh').cost).toBe('$0.04');
  });
});

describe('NodeDetailDrawer', () => {
  test('renders the loading state while the task is being fetched', () => {
    const html = renderToStaticMarkup(createElement(NodeDetailDrawer, {
      runId: RUN_ID,
      taskId: TASK_ID,
      onClose: () => {},
      locale: 'en',
      fetcher: vi.fn(),
    }));

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(MESSAGES.en.guided.nodeDetail.title);
    expect(html).toContain(MESSAGES.en.guided.nodeDetail.close);
    expect(html).not.toContain(MESSAGES.en.guided.nodeDetail.changedFiles);
  });

  test('renders nothing and never fetches when no task is selected', () => {
    const fetcher = vi.fn();
    const html = renderToStaticMarkup(createElement(NodeDetailDrawer, {
      runId: RUN_ID,
      taskId: null,
      onClose: () => {},
      locale: 'en',
      fetcher,
    }));

    expect(html).toBe('');
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('loads a full RunTaskDetail through the injected fetcher', async () => {
    const pending = deferred<RunTaskDetail>();
    const fetcher = vi.fn(() => pending.promise);
    const { container } = await renderDrawer({ fetcher });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(RUN_ID, TASK_ID);
    expect(container.find('div', (node) => node.attrs.get('role') === 'status')).toBeDefined();
    expect(field(container, 'cost')).toBeUndefined();

    await act(async () => {
      pending.resolve(detail);
    });

    expect(container.find('div', (node) => node.attrs.get('role') === 'status')).toBeUndefined();
    expect(container.find('div', (node) => node.attrs.get('role') === 'alert')).toBeUndefined();
    expect(container.text).toContain('Add task detail endpoint');
    expect(container.text).toContain(TASK_ID);
    expect(field(container, 'status')).toBe('PASSED');
    expect(field(container, 'model')).toBe('claude_sub / sonnet');
    expect(field(container, 'elapsed')).toBe('1m 30s');
    expect(field(container, 'cost')).toBe('$0.04');
    expect(field(container, 'tests')).toBe('passed');
    expect(field(container, 'verdict')).toBe('PASS');

    const files = container.findByAttr('data-field', 'changed-files');
    expect(files?.children.filter((node) => node.tagName === 'li').map((node) => node.text))
      .toEqual(detail.changed_files);
    expect(container.text).toContain(detail.summary);

    const highlight = container.findByAttr('class', 'glossary-term__trigger');
    expect(highlight?.text).toBe('Plan DAG');
  });

  test('shows a rejected fetch as an alert without any detail fields', async () => {
    const pending = deferred<RunTaskDetail>();
    const fetcher = vi.fn(() => pending.promise);
    const { container } = await renderDrawer({ fetcher });

    await act(async () => {
      pending.reject(new Error('detail endpoint unavailable'));
    });

    const alert = container.find('div', (node) => node.attrs.get('role') === 'alert');
    expect(alert?.text).toContain('detail endpoint unavailable');
    expect(field(container, 'cost')).toBeUndefined();
    expect(container.findByAttr('class', 'glossary-term__trigger')).toBeUndefined();
    expect(container.text).toContain(MESSAGES.en.guided.nodeDetail.close);
  });
});
