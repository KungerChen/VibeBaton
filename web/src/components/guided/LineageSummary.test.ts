import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { MESSAGES } from '../../i18n/messages';
import { LineageSummary, type LineageSummaryProps } from './LineageSummary';

const ROOT_SHA = '1a2b3c4d5e6f7890';
const PARENT_SHA = '2b3c4d5e6f789012';
const RESULT_SHA = '3c4d5e6f78901234';
const CURRENT_BASE_SHA = '4d5e6f7890123456';
const MERGED_SHA = '5e6f789012345678';

function renderLineage(locale: 'en' | 'zh', props: LineageSummaryProps): string {
  vi.stubGlobal('window', { localStorage: { getItem: () => locale } });
  return renderToStaticMarkup(createElement(I18nProvider, { children: createElement(LineageSummary, props) }));
}

function lineageProps(overrides: Partial<LineageSummaryProps> = {}): LineageSummaryProps {
  return {
    runId: 'run-current',
    status: 'RUNNING',
    lineage: { parent_run_id: null, base_ref: null, start_sha: null, result_sha: null },
    rootStartSha: null,
    currentBaseSha: null,
    ...overrides,
  };
}

function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
}

function nodeCount(html: string): number {
  return (html.match(/data-node="/g) ?? []).length;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LineageSummary', () => {
  test.each(['en', 'zh'] as const)('renders a three-node chain with short SHAs in %s', (locale) => {
    const copy = MESSAGES[locale].guided.m3.signOff;
    const html = renderLineage(locale, lineageProps({
      status: 'SUPERSEDED',
      lineage: {
        parent_run_id: 'run-parent',
        base_ref: 'main',
        start_sha: PARENT_SHA,
        result_sha: RESULT_SHA,
      },
      rootStartSha: ROOT_SHA,
      currentBaseSha: ROOT_SHA,
      mergedSha: MERGED_SHA,
    }));
    const text = visibleText(html);
    expect(nodeCount(html)).toBe(3);
    expect(html).toContain('data-node="base"');
    expect(html).toContain('data-node="parent"');
    expect(html).toContain('data-node="current"');
    expect(text).toContain(copy.baseBranch);
    expect(text).toContain(copy.baseSha);
    expect(text).toContain(copy.parentRun);
    expect(text).toContain(copy.currentRun);
    expect(text).toContain(copy.resultSha);
    expect(text).toContain(copy.mergedSha);
    expect(text).toContain('main');
    expect(text).toContain(ROOT_SHA.slice(0, 7));
    expect(text).toContain(PARENT_SHA.slice(0, 7));
    expect(text).toContain(RESULT_SHA.slice(0, 7));
    expect(text).toContain(MERGED_SHA.slice(0, 7));
    expect(text).not.toContain(ROOT_SHA);
    expect(text).not.toContain(PARENT_SHA);
    expect(text).not.toContain(RESULT_SHA);
    expect(text).not.toContain(MERGED_SHA);
    expect(html).toContain(`title="${ROOT_SHA}"`);
    expect(html).toContain(`title="${PARENT_SHA}"`);
    expect(html).toContain(`title="${RESULT_SHA}"`);
    expect(html).toContain(`title="${MERGED_SHA}"`);
    expect(html).toContain('data-status="SUPERSEDED"');
    expect(html).not.toContain('data-state="drift"');
  });

  test('renders a two-node root chain and a one-node legacy chain', () => {
    const copy = MESSAGES.en.guided.m3.signOff;
    const root = renderLineage('en', lineageProps({
      lineage: { parent_run_id: null, base_ref: 'main', start_sha: ROOT_SHA, result_sha: RESULT_SHA },
      rootStartSha: ROOT_SHA,
      currentBaseSha: ROOT_SHA,
    }));
    expect(nodeCount(root)).toBe(2);
    expect(root).not.toContain('data-node="parent"');
    expect(visibleText(root)).toContain(ROOT_SHA.slice(0, 7));
    expect(visibleText(root)).toContain(RESULT_SHA.slice(0, 7));

    const single = renderLineage('en', lineageProps());
    expect(nodeCount(single)).toBe(1);
    expect(single).toContain('data-node="current"');
    expect(visibleText(single)).not.toContain(copy.baseSha);
    expect(visibleText(single)).not.toContain(copy.parentRun);
    expect(visibleText(single)).toContain('—');
  });

  test('keeps every lineage node when its SHAs are missing', () => {
    const copy = MESSAGES.zh.guided.m3.signOff;
    const html = renderLineage('zh', lineageProps({
      lineage: { parent_run_id: 'run-parent', base_ref: 'main', start_sha: null, result_sha: null },
      rootStartSha: null,
      currentBaseSha: null,
    }));
    const text = visibleText(html);
    expect(nodeCount(html)).toBe(3);
    expect((text.match(/—/g) ?? []).length).toBe(3);
    expect(text).not.toContain('null');
    expect(text).toContain(copy.baseBranch);
    expect(text).toContain('run-parent');
  });

  test('does not use a revision start SHA as the base baseline', () => {
    const html = renderLineage('en', lineageProps({
      lineage: { parent_run_id: 'run-parent', base_ref: 'main', start_sha: PARENT_SHA, result_sha: RESULT_SHA },
      rootStartSha: null,
      currentBaseSha: null,
    }));
    const text = visibleText(html);
    expect(nodeCount(html)).toBe(3);
    expect((text.match(new RegExp(PARENT_SHA.slice(0, 7), 'g')) ?? []).length).toBe(1);
    expect(text).toContain('—');
  });

  test('marks an externally advanced base and stays quiet when it matches', () => {
    const copy = MESSAGES.en.guided.m3;
    const advanced = renderLineage('en', lineageProps({
      lineage: { parent_run_id: null, base_ref: 'main', start_sha: ROOT_SHA, result_sha: RESULT_SHA },
      rootStartSha: ROOT_SHA,
      currentBaseSha: CURRENT_BASE_SHA,
    }));
    const advancedText = visibleText(advanced);
    expect(advanced).toContain('data-state="drift"');
    expect(advancedText).toContain(copy.drift.title);
    expect(advancedText).toContain(copy.drift.description);
    expect(advancedText).toContain(copy.signOff.currentBaseSha);
    expect(advancedText).toContain(CURRENT_BASE_SHA.slice(0, 7));
    expect(advancedText).not.toContain(CURRENT_BASE_SHA);

    const unchanged = renderLineage('en', lineageProps({
      lineage: { parent_run_id: null, base_ref: 'main', start_sha: ROOT_SHA, result_sha: RESULT_SHA },
      rootStartSha: ROOT_SHA,
      currentBaseSha: ROOT_SHA.toUpperCase(),
    }));
    expect(unchanged).not.toContain('data-state="drift"');
    expect(visibleText(unchanged)).not.toContain(copy.drift.title);

    const unknown = renderLineage('en', lineageProps({ rootStartSha: ROOT_SHA, currentBaseSha: null }));
    expect(unknown).not.toContain('data-state="drift"');

    const revisionBaseline = renderLineage('en', lineageProps({
      lineage: { parent_run_id: 'run-parent', base_ref: 'main', start_sha: PARENT_SHA, result_sha: RESULT_SHA },
      rootStartSha: ROOT_SHA,
      currentBaseSha: PARENT_SHA,
    }));
    expect(revisionBaseline).toContain('data-state="drift"');
  });

  test('treats the merge commit as the new base instead of external drift', () => {
    const copy = MESSAGES.en.guided.m3;
    const html = renderLineage('en', lineageProps({
      status: 'COMPLETED',
      lineage: { parent_run_id: 'run-parent', base_ref: 'main', start_sha: PARENT_SHA, result_sha: RESULT_SHA },
      rootStartSha: ROOT_SHA,
      currentBaseSha: MERGED_SHA,
      mergedSha: MERGED_SHA,
    }));
    const text = visibleText(html);
    expect(text).toContain(MERGED_SHA.slice(0, 7));
    expect(html).toContain('data-status="COMPLETED"');
    expect(html).not.toContain('data-state="drift"');
    expect(text).not.toContain(copy.drift.title);
    expect(text).not.toContain(copy.drift.description);
  });

  test('exposes each status so SUPERSEDED is styled apart from active runs', () => {
    const superseded = renderLineage('en', lineageProps({ status: 'SUPERSEDED' }));
    const running = renderLineage('en', lineageProps({ status: 'RUNNING' }));
    expect(superseded).toContain('data-status="SUPERSEDED"');
    expect(running).toContain('data-status="RUNNING"');
    expect(superseded).not.toBe(running);
  });
});
