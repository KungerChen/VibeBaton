import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import type { FinalizeRequest, FinalizeResult } from '../../api/client';
import { MESSAGES } from '../../i18n/messages';
import {
  GuidedSignOffPanel,
  buildFinalizePayload,
  summarizeSignOff,
  type GuidedSignOffPanelProps,
  type SignOffSummary,
} from './GuidedSignOffPanel';

const EN = MESSAGES.en.guided.signOff;
const ZH = MESSAGES.zh.guided.signOff;

const summary: SignOffSummary = {
  testsPassed: 12,
  testsTotal: 12,
  changedFiles: ['web/src/App.tsx', 'web/src/components/guided/GuidedSignOffPanel.tsx'],
  reportUrl: '/api/runs/run-42/report',
};

const rollbackResult: FinalizeResult = {
  ok: true,
  run_id: 'run-42',
  action: 'rollback',
  status: 'PAUSED',
  backup_tag: 'baton-backup/run-42',
  base_branch: 'main',
  base_head: 'abc123',
  restored_to: 'def456',
};

function decodeHtml(html: string): string {
  return html
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&amp;', '&');
}

function renderPanel(overrides: Partial<GuidedSignOffPanelProps> = {}): string {
  return renderToStaticMarkup(createElement(GuidedSignOffPanel, {
    runId: 'run-42',
    summary,
    locale: 'en',
    onFinalized: () => {},
    finalizer: async () => rollbackResult,
    ...overrides,
  }));
}

describe('buildFinalizePayload', () => {
  test('trims notes and omits a blank note for every action', () => {
    expect(buildFinalizePayload('approve', '   ')).toEqual({ action: 'approve' });
    expect(buildFinalizePayload('rollback', '')).toEqual({ action: 'rollback' });
    expect(buildFinalizePayload('revise', '  Add a regression test  ')).toEqual({
      action: 'revise',
      note: 'Add a regression test',
    });
  });
});

describe('summarizeSignOff', () => {
  test('localizes the passing headline and the changed-file count', () => {
    const en = summarizeSignOff(summary, 'en');
    expect(en).toMatchObject({ allPassed: true, reportUrl: summary.reportUrl });
    expect(en.tests).toContain('12/12');
    expect(en.tests).toContain(EN.testsPassed);
    expect(en.changedFiles).toContain(EN.changedFiles);
    expect(en.changedFiles).toContain('2');

    const zh = summarizeSignOff(summary, 'zh');
    expect(zh.tests).toContain(ZH.testsPassed);
    expect(zh.changedFiles).toContain(ZH.changedFiles);
  });

  test('never claims success when checks failed or no test ran', () => {
    const partial = summarizeSignOff({ ...summary, testsPassed: 9 }, 'en');
    expect(partial.allPassed).toBe(false);
    expect(partial.tests).toContain('9/12');
    expect(partial.tests).not.toContain(EN.testsPassed);

    const empty = summarizeSignOff({ ...summary, testsPassed: 0, testsTotal: 0 }, 'en');
    expect(empty.allPassed).toBe(false);
    expect(empty.tests).not.toContain(EN.testsPassed);
  });
});

describe('GuidedSignOffPanel', () => {
  test('renders the verification summary, changed files, report link and three actions', () => {
    const html = renderPanel();
    const text = decodeHtml(html);

    expect(html).toContain('class="guided-sign-off"');
    expect(text).toContain(EN.title);
    expect(text).toContain('run-42');
    expect(text).toContain('12/12');
    expect(text).toContain(EN.testsPassed);
    expect(text).toContain(EN.changedFiles);
    expect(text).toContain(summary.changedFiles[0]);
    expect(html).toContain(`href="${summary.reportUrl}"`);
    expect(text).toContain(EN.battleReport);
    expect(text).toContain(EN.approve);
    expect(text).toContain(EN.revise);
    expect(text).toContain(EN.rollback);
    expect(text).not.toContain(EN.rollbackConfirm);
  });

  test('falls back to the run report endpoint when the summary URL is blank', () => {
    const html = renderPanel({ summary: { ...summary, reportUrl: '   ' } });
    expect(html).toContain('href="/api/runs/run-42/report"');
  });

  test('localizes every visible label from guided.signOff', () => {
    const text = decodeHtml(renderPanel({ locale: 'zh' }));

    expect(text).toContain(ZH.title);
    expect(text).toContain(ZH.testsPassed);
    expect(text).toContain(ZH.changedFiles);
    expect(text).toContain(ZH.battleReport);
    expect(text).toContain(ZH.approve);
    expect(text).toContain(ZH.revise);
    expect(text).toContain(ZH.rollback);
    expect(text).not.toContain(EN.approve);
    expect(text).not.toContain(EN.revise);
    expect(text).not.toContain(EN.rollback);
  });

  test('rollback is not called before the inline confirmation, then is called', async () => {
    type Listener = (event: Record<string, unknown>) => void;
    const listeners = new Map<string, Listener>();
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
      readonly style = {};
      parentNode: TestNode | null = null;
      value = '';

      constructor(readonly tagName: string, public textContent = '') {
        this.nodeType = tagName === '#text' ? 3 : 1;
      }

      addEventListener(type: string, callback: Listener, capture: boolean) {
        if (!capture) listeners.set(type, callback);
      }

      setAttribute() {}
      removeAttribute() {}
      focus() {}

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
    }

    const click = (node: TestNode) => {
      const listener = listeners.get('click');
      if (!listener) throw new Error('Missing React click listener');
      listener({ type: 'click', target: node, button: 0 });
    };

    let resolveFinalize!: (result: FinalizeResult) => void;
    const finalizer = vi.fn((_runId: string, _payload: FinalizeRequest) => new Promise<FinalizeResult>((resolve) => {
      resolveFinalize = resolve;
    }));
    const onFinalized = vi.fn((_result: FinalizeResult) => {});
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { HTMLIFrameElement: class HTMLIFrameElement {} });
    const container = new TestNode('DIV');
    const root = createRoot(container as unknown as HTMLElement);

    try {
      await act(async () => {
        root.render(createElement(GuidedSignOffPanel, {
          runId: 'run-42',
          summary,
          locale: 'en',
          onFinalized,
          finalizer,
        }));
      });

      const firstRollback = container.find('button', (node) => node.text === EN.rollback);
      expect(firstRollback).toBeDefined();
      await act(async () => click(firstRollback!));

      expect(finalizer).not.toHaveBeenCalled();
      expect(container.text).toContain(EN.rollbackConfirm);

      const confirmRollback = container.find('button', (node) => node.text === EN.rollback);
      expect(confirmRollback).toBeDefined();
      await act(async () => click(confirmRollback!));

      expect(finalizer).toHaveBeenCalledTimes(1);
      expect(finalizer).toHaveBeenCalledWith('run-42', { action: 'rollback' });

      await act(async () => {
        resolveFinalize(rollbackResult);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(onFinalized).toHaveBeenCalledWith(rollbackResult);
    } finally {
      try {
        act(() => root.unmount());
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });
});
