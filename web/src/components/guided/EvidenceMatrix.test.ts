import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import type { EvidenceCriterion, GateReceipt, RunEvidenceResponse } from '../../api/client';
import { MESSAGES } from '../../i18n/messages';
import { EvidenceMatrix, EvidenceTable, evidenceCell } from './EvidenceMatrix';
import signOffSource from './GuidedSignOffPanel.tsx?raw';
import workbenchSource from './GuidedWorkbench.tsx?raw';

function receipt(eventId: number, command: string, exitCode: number, more: Partial<GateReceipt> = {}): GateReceipt {
  return { event_id: eventId, scope: 'milestone', target_id: 'M1', command, exit_code: exitCode, passed: exitCode === 0,
    duration_sec: 0.2, output_tail: `output of ${command}`, created_at: eventId, ...more };
}
function criterion(index: number, text: string, more: Partial<EvidenceCriterion> = {}): EvidenceCriterion {
  return { index, text, state: 'not_linked', result: null, receipts: [], files: [], ...more };
}
function evidence(more: Partial<RunEvidenceResponse> = {}): RunEvidenceResponse {
  const criteria = more.criteria ?? [];
  return { run_id: 'r1', rfc_available: true, criteria, run_level_receipts: [],
    summary: { criteria: criteria.length, passed: 0, failed: 0, files_only: 0, not_linked: 0, receipts: 0 }, ...more };
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
const draw = (value: RunEvidenceResponse, locale: 'en' | 'zh' = 'en') =>
  renderToStaticMarkup(createElement(EvidenceTable, { evidence: value, locale }));
/** The cell state each row carries, in row order. */
const cells = (html: string) => [...html.matchAll(/<tr data-criterion="(\d+)" data-cell="([a-z_]+)"/g)].map((m) => `${m[1]}:${m[2]}`);

const ROWS = [
  criterion(1, '`python hello.py` prints the greeting.', { state: 'receipt', result: 'passed', receipts: [receipt(5, 'python hello.py', 0)] }),
  criterion(2, 'hello.py is the only file that changes.', { state: 'files_only', files: ['hello.py'] }),
  criterion(3, 'The greeting reads well to a person.'),
  criterion(4, '`npm test` passes.', { state: 'receipt', result: 'failed', receipts: [receipt(6, 'npm test', 2)] }),
];

describe('evidenceCell', () => {
  test('a row is passed only with a receipt whose latest result has exit code 0', () => {
    expect(ROWS.map(evidenceCell)).toEqual(['receipt_passed', 'files_only', 'not_linked', 'receipt_failed']);
    // The latest receipt of a command decides: failed then fixed is passed, passed then broken is failed.
    expect(evidenceCell(criterion(1, 'x', { state: 'receipt', result: 'passed',
      receipts: [receipt(1, 'make check', 1), receipt(2, 'make check', 0)] }))).toBe('receipt_passed');
    expect(evidenceCell(criterion(1, 'x', { state: 'receipt', result: 'failed',
      receipts: [receipt(1, 'make check', 0), receipt(2, 'make check', 2)] }))).toBe('receipt_failed');
  });

  test('nothing but a receipt with exit code 0 can make a row passed', () => {
    // A result that says passed without any receipt, with a failing receipt, or on a row with only files.
    expect(evidenceCell(criterion(1, 'x', { state: 'receipt', result: 'passed', receipts: [] }))).toBe('not_linked');
    expect(evidenceCell(criterion(1, 'x', { state: 'receipt', result: 'passed',
      receipts: [receipt(1, 'npm test', 1, { passed: true })] }))).toBe('receipt_failed');
    expect(evidenceCell(criterion(1, 'x', { state: 'files_only', result: 'passed', files: ['a.py'] }))).toBe('files_only');
    expect(evidenceCell(criterion(1, 'x', { state: 'not_linked', result: 'passed' }))).toBe('not_linked');
  });
});

describe('the Sign-Off evidence matrix', () => {
  test('every criterion is one row with one of the three states, and only receipts count in the summary', () => {
    const html = draw(evidence({ criteria: ROWS, run_level_receipts: [receipt(7, 'git status --short', 0)] }));
    expect(cells(html)).toEqual(['1:receipt_passed', '2:files_only', '3:not_linked', '4:receipt_failed']);
    const copy = MESSAGES.en.guided.evidence;
    const shown = text(html);
    expect(shown).toContain('1 of 4 criteria have a gate receipt that passed; 1 have a gate receipt that failed');
    for (const state of Object.values(copy.states)) expect(shown).toContain(state);
    // Changed files and a missing link say so in words and carry no pass mark.
    expect(shown).toContain(copy.filesOnlyNote);
    expect(shown).toContain(copy.notLinkedNote);
    const row = (index: number) => html.split('<tr data-criterion=')[index].split('</tr>')[0];
    expect(row(2)).not.toContain('evidence-matrix__pass');
    expect(row(3)).not.toContain('evidence-matrix__pass');
    expect(text(row(3))).not.toMatch(/passed/i);
    // A receipt opens to its command, exit code and output.
    expect(text(row(1))).toContain('python hello.py');
    expect(text(row(1))).toContain('exit code 0');
    expect(text(row(1))).toContain('output of python hello.py');
    expect(text(row(4))).toContain('exit code 2');
    expect(row(4)).toContain('evidence-matrix__fail');
    expect(text(row(2))).toContain('hello.py');
  });

  test('receipts no criterion names are listed as run-level receipts, never attached to a row', () => {
    const html = draw(evidence({ criteria: [ROWS[2]], run_level_receipts: [receipt(7, 'git status --short', 0), receipt(8, 'npm run lint', 1)] }));
    expect(cells(html)).toEqual(['3:not_linked']);
    const runLevel = html.split('data-field="run-level"')[1];
    expect(text(runLevel)).toContain(MESSAGES.en.guided.evidence.runLevel);
    expect(text(runLevel)).toContain('git status --short');
    expect(text(runLevel)).toContain('npm run lint');
    expect([...runLevel.matchAll(/data-passed="(true|false)"/g)].map((m) => m[1])).toEqual(['true', 'false']);
    expect(text(html)).toContain('0 of 1 criteria have a gate receipt that passed');
  });

  test('a run without receipts shows no pass anywhere and says so', () => {
    const html = draw(evidence({ criteria: [ROWS[1], ROWS[2]] }));
    expect(cells(html)).toEqual(['2:files_only', '3:not_linked']);
    expect(text(html)).toContain(MESSAGES.en.guided.evidence.noReceiptsAtAll);
    expect(text(html)).toContain('0 of 2 criteria have a gate receipt that passed');
    expect(html).not.toContain('evidence-matrix__pass');
    expect(html).not.toContain('data-cell="receipt_passed"');
  });

  test('a revision whose blueprint repeats the numbering keeps every row', () => {
    // The snapshot of a child run holds the earlier blueprint and the revised one; both sets of criteria are shown.
    const html = draw(evidence({ criteria: [ROWS[0], ROWS[2], { ...ROWS[0], text: 'revised' }, { ...ROWS[2], text: 'revised too' }] }));
    expect(cells(html)).toEqual(['1:receipt_passed', '3:not_linked', '1:receipt_passed', '3:not_linked']);
    expect(text(html)).toContain('2 of 4 criteria have a gate receipt that passed');
  });

  test('no criteria and an unreadable blueprint each say what is missing', () => {
    expect(text(draw(evidence()))).toContain(MESSAGES.en.guided.evidence.noCriteria);
    expect(text(draw(evidence({ rfc_available: false })))).toContain(MESSAGES.en.guided.evidence.noRfc);
  });

  test('the Chinese copy names the same three states', () => {
    const shown = text(draw(evidence({ criteria: ROWS }), 'zh'));
    for (const label of ['有门禁回执：通过', '有门禁回执：失败', '仅有改动文件', '未关联', '运行级回执']) expect(shown).toContain(label);
    expect(shown).toContain('4 条验收条件中，1 条有通过的门禁回执，1 条的门禁回执是失败');
  });
});

describe('loading the matrix', () => {
  test('reads the evidence of the shown run, again when its status changes, and offers a retry on failure', async () => {
    type TestNode = {
      nodeType: number; tagName: string; children: TestNode[]; textContent: string; parentNode: TestNode | null;
      [key: string]: unknown;
    };
    const document: Record<string, unknown> = { addEventListener() {} };
    const node = (tag: string, value = ''): TestNode => ({
      nodeType: tag === '#text' ? 3 : 1, tagName: tag, children: [], style: {}, ownerDocument: document, parentNode: null,
      textContent: value,
      setAttribute() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {},
      appendChild(child: TestNode) { (this as unknown as TestNode).children.push(child); child.parentNode = this as unknown as TestNode; },
      insertBefore(child: TestNode, before: TestNode | null) {
        const self = this as unknown as TestNode;
        self.children.splice(before ? self.children.indexOf(before) : self.children.length, 0, child);
        child.parentNode = self;
      },
      removeChild(child: TestNode) { const self = this as unknown as TestNode; self.children.splice(self.children.indexOf(child), 1); },
    });
    document.createElement = (tag: string) => node(tag);
    document.createElementNS = (_: string, tag: string) => node(tag);
    document.createTextNode = (value: string) => node('#text', value);
    const shown = (item: TestNode): string => item.textContent + item.children.map(shown).join(' ');

    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { HTMLIFrameElement: class {}, localStorage: { getItem: () => 'en' } });
    const loader = vi.fn(async (runId: string) => evidence({ run_id: runId, criteria: [ROWS[0]] }));
    const container = node('DIV');
    const root = createRoot(container as unknown as HTMLElement);
    const render = (runId: string, runStatus: string) =>
      act(async () => root.render(createElement(EvidenceMatrix, { runId, runStatus, locale: 'en', loader })));
    try {
      await render('r1', 'READY_FOR_FINAL_GATE');
      expect(loader.mock.calls).toEqual([['r1']]);
      expect(shown(container)).toContain('Gate receipt: passed');
      await render('r1', 'COMPLETED');
      expect(loader).toHaveBeenCalledTimes(2);
      loader.mockRejectedValueOnce(new Error('offline'));
      await render('r2', 'COMPLETED');
      expect(loader).toHaveBeenLastCalledWith('r2');
      // Another run's rows never stand in while this run's evidence is missing.
      expect(shown(container)).toContain(MESSAGES.en.guided.evidence.failed);
      expect(shown(container)).not.toContain('Gate receipt: passed');
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  test('Sign-Off shows the matrix through the evidence endpoint of the shown run', () => {
    expect(signOffSource).toContain('<EvidenceMatrix runId={runId} runStatus={runStatus} locale={locale} loader={evidenceLoader} />');
    expect(workbenchSource).toContain('client.getRunEvidence(id)');
    expect(workbenchSource).toContain('evidenceLoader={evidenceLoader}');
  });
});
