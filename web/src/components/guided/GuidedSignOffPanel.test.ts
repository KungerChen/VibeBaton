/*
 * 20261126-180155-m3-t5-signoff (-08:00): M3-T5, limited to the three whitelisted panel files.
 * Added SHA-aware merge/rollback states, guarded confirmations and a host revision-transition contract.
 * Validation: panel, workbench and lineage tests with --configLoader runner; TypeScript typecheck.
 * The literal test command is blocked by EPERM in the shared node_modules config loader.
 * Status: partial self-test; Step 2 host wiring and a read-only current-HEAD/guidance API remain unavailable
 * within this whitelist. Browser inspection was blocked by the current approval policy.
 * Rollback reference: base commit 6ad1776 and this worktree's tracked diff; no commit was made.
 */
import { act, Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, assert, describe, expect, test, vi } from 'vitest';
import { ApiError, BatonApiClient, type FinalizeResult, type GateCommandResult, type RollbackMode } from '../../api/client';
import { MESSAGES } from '../../i18n/messages';
import { Button } from '../ui/button';
import { Textarea } from '../ui/input';
import {
  GuidedSignOffPanel,
  buildFinalizePayload,
  summarizeSignOff,
  useGuidedSignOffView,
  verificationState,
  type GuidedSignOffPanelProps,
  type SignOffLineage,
  type SignOffSummary,
} from './GuidedSignOffPanel';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const M = 'd'.repeat(40);
const LATER = 'e'.repeat(40);
const en = MESSAGES.en.guided;
const summary: SignOffSummary = {
  testsPassed: 12, testsTotal: 12, changedFiles: ['src/example.ts'], reportUrl: '/api/runs/run-42/report',
};
const lineage: SignOffLineage = {
  status: 'READY_FOR_FINAL_GATE',
  lineage: { parent_run_id: 'run-parent', base_ref: 'main', start_sha: B, result_sha: C },
  rootStartSha: A, currentBaseSha: A, mergedSha: null, preMergeSha: null,
};
const mergedLineage: SignOffLineage = {
  ...lineage, status: 'COMPLETED', currentBaseSha: M, mergedSha: M, preMergeSha: B,
};
const gate: GateCommandResult = {
  command: 'npm test', passed: false, exit_code: 1, stdout: '', stderr: 'assertion failed', duration_sec: 0.2,
};

function approval(reintegrated = false): FinalizeResult {
  return { ok: true, run_id: 'run-42', action: 'approve', status: 'COMPLETED', backup_tag: null,
    base_branch: 'main', base_head: M, merged_commit: M, changed_files: ['src/example.ts'],
    reintegrated, gates: reintegrated ? [{ ...gate, passed: true, exit_code: 0, stderr: '' }] : [] };
}

function defaultProps(overrides: Partial<GuidedSignOffPanelProps> = {}): GuidedSignOffPanelProps {
  return {
    runId: 'run-42', runStatus: 'READY_FOR_FINAL_GATE', summary, locale: 'en', lineage,
    onFinalized: vi.fn(), finalizer: vi.fn(async () => approval()),
    lineageLoader: vi.fn(async () => lineage),
    rollbacker: vi.fn(async (runId: string, mode: RollbackMode) => ({ ok: true as const, run_id: runId, mode, status: 'PAUSED' as const,
      restored_to: mode === 'abandon_all' ? A : B, base_branch: 'main', base_head: A })),
    priorRfc: '# Original RFC\nKeep this scope',
    onRequestRevision: vi.fn(async () => ({ run_id: 'run-42', status: 'SUPERSEDED' as const })),
    ...overrides,
  };
}

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) => isValidElement<Record<string, unknown>>(child)
    ? [child, ...elements(child.props.children as ReactNode)] : []);
}

let root: Root | undefined;
let view: ReactNode;
let props: GuidedSignOffPanelProps;

async function mount(overrides: Partial<GuidedSignOffPanelProps> = {}) {
  props = defaultProps(overrides);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', { HTMLIFrameElement: class HTMLIFrameElement {} });
  const container = { nodeType: 1, tagName: 'DIV', ownerDocument: null, addEventListener() {} };
  root = createRoot(container as unknown as HTMLElement);
  function Probe() { view = useGuidedSignOffView(props); return null; }
  await act(async () => { root!.render(createElement(Probe)); });
  return async (next: Partial<GuidedSignOffPanelProps>) => {
    props = { ...props, ...next };
    await act(async () => { root!.render(createElement(Probe)); });
  };
}

function findButton(label: string) {
  return elements(view).find((node) => node.type === Button && node.props.children === label);
}

function button(label: string) {
  const node = findButton(label);
  assert(node, `Expected button: ${label}`);
  return node;
}

async function click(label: string) {
  const node = button(label);
  expect(node.props.disabled).not.toBe(true);
  await act(async () => { (node.props.onClick as () => void)(); });
}

function html() { return renderToStaticMarkup(view); }

function confirmationHtml() {
  const group = elements(view).find((node) => node.props.role === 'group' && node.props['aria-label'] === en.m3.rollback.confirm);
  assert(group, 'Expected rollback confirmation');
  return renderToStaticMarkup(group);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('sign-off summary', () => {
  test('preserves payload and verification wording without overstating test results', () => {
    expect(buildFinalizePayload('revise', '  add coverage  ')).toEqual({ action: 'revise', note: 'add coverage' });
    expect(buildFinalizePayload('approve', ' ')).toEqual({ action: 'approve' });
    expect(summarizeSignOff(summary, 'en').allPassed).toBe(true);
    expect(summarizeSignOff({ ...summary, testsPassed: 0, testsTotal: 0 }, 'en').allPassed).toBe(false);
    expect(summarizeSignOff({ ...summary, testsPassed: 9 }, 'zh').allPassed).toBe(false);
  });

  test('the count is worded as tasks completed and never claims that verification checks passed', () => {
    // It counts tasks whose status is PASSED; whether any check ran for them is a different fact.
    for (const locale of ['en', 'zh'] as const) {
      const copy = MESSAGES[locale].guided.signOff;
      const markup = renderToStaticMarkup(createElement(GuidedSignOffPanel, defaultProps({ locale, summary })));
      for (const text of [copy.kpiTests, copy.testsPassed, copy.testsSummary(9, 12)]) {
        expect(text).not.toMatch(/check|verif|检查|验证/i);
      }
      expect(markup).toContain(copy.kpiTests);
      expect(markup).toContain(`12/12 · ${copy.testsPassed}`);
    }
    expect(summarizeSignOff(summary, 'en').tests).toBe('12/12 · All tasks completed');
    expect(summarizeSignOff({ ...summary, testsPassed: 9 }, 'zh').tests).toBe('9/12 个任务已完成');
  });

  test('renders the actual lineage, report, files, deliverables and cost', () => {
    const markup = renderToStaticMarkup(createElement(GuidedSignOffPanel, defaultProps({ summary: {
      ...summary, totalCostUsd: 0.425, workspacePath: '/repo',
      deliverables: [{ id: 'T1', title: 'Health check', status: 'PASSED', summary: 'Completed' }],
    }, initialReportMarkdown: '## Battle report' })));
    expect(markup).toContain('run-parent');
    expect(markup).toContain(`title="${A}"`);
    expect(markup).toContain(`title="${B}"`);
    expect(markup).toContain(`title="${C}"`);
    expect(markup).toContain('/api/runs/run-42/report');
    expect(markup).toContain('src/example.ts');
    expect(markup).toContain('Health check');
    expect(markup).toContain('$0.425');
    expect(markup).toContain('Battle report');
  });

  test('a total no call reported reads "Not reported", a real zero stays $0, and both name the coverage', () => {
    const notReported = renderToStaticMarkup(createElement(GuidedSignOffPanel, defaultProps({ summary: {
      ...summary, totalCostUsd: null, usage: { reported_calls: 0, total_calls: 4 },
    } })));
    expect(notReported).toContain(MESSAGES.en.inspector.billingNotReported);
    expect(notReported).toContain('0 of 4 calls reported usage');
    expect(notReported).not.toContain('$0.00');
    const zero = renderToStaticMarkup(createElement(GuidedSignOffPanel, defaultProps({ locale: 'zh', summary: {
      ...summary, totalCostUsd: 0, usage: { reported_calls: 2, total_calls: 2 },
    } })));
    expect(zero).toContain('$0.0000');
    expect(zero).toContain('2 次调用中 2 次上报了用量');
    expect(zero).not.toContain(MESSAGES.zh.inspector.billingNotReported);
  });
});

function outcomeBlock() {
  const node = elements(view).find((item) => typeof item.props['data-outcome'] === 'string');
  assert(node, 'Expected the merge result');
  return node;
}

/** The rendered verification result (a child component, so read from the markup), or null when absent. */
function verificationBlock(): { state: string; markup: string } | null {
  const match = /<section class="guided-sign-off__verification" data-verification="([a-z_]+)"[\s\S]*?<\/section>/.exec(html());
  return match ? { state: match[1], markup: match[0] } : null;
}

describe('verification result', () => {
  test('has four states, and an empty or missing gate list is never "passed"', () => {
    const passing = { ...gate, passed: true, exit_code: 0, stderr: '' };
    expect(verificationState(undefined)).toBe('not_returned');
    expect(verificationState(null)).toBe('not_returned');
    expect(verificationState({ gates: [] })).toBe('not_returned');
    expect(verificationState([])).toBe('not_configured');
    expect(verificationState([passing, passing])).toBe('passed');
    expect(verificationState([passing, gate])).toBe('failed');
    expect(verificationState([{ command: 'npm test' }])).toBe('failed');
  });

  test('a re-integration that returned no gates shows "No gate records" in a neutral block, apart from the merge', async () => {
    await mount({ finalizer: vi.fn(async () => ({ ...approval(true), gates: [] })) });
    await click(en.signOff.approve);
    expect(en.m3.signOff.noGates).toBe('No gate records');
    expect(MESSAGES.zh.guided.m3.signOff.noGates).toBe('无门禁记录');
    const verification = verificationBlock();
    assert(verification, 'Expected a verification result');
    expect(verification.state).toBe('not_configured');
    expect(verification.markup).toContain(en.m3.signOff.noGates);
    expect(html()).not.toContain('data-verification="passed"');
    // Only "passed" (green) and "failed" (red) are coloured; the other two keep the neutral base style.
    // The frontend dependencies omit @types/node, so type only the Node API used here.
    const { readFileSync } = await vi.importActual<{ readFileSync(path: URL, encoding: 'utf8'): string }>('node:fs');
    const signOffCss = readFileSync(new URL('./GuidedSignOffPanel.css', import.meta.url), 'utf8');
    expect(signOffCss).toMatch(/\[data-verification='passed'\]\s*\{[^}]*--emerald/);
    expect(signOffCss).not.toMatch(/not_configured|not_returned/);
    expect(verification.markup).not.toContain(en.m3.signOff.verificationPassed);
    // The merge result says only what happened to the branch.
    const merge = renderToStaticMarkup(outcomeBlock());
    expect(merge).toContain(en.m3.signOff.reintegrated);
    expect(merge).not.toContain(en.m3.signOff.noGates);
    expect(en.m3.signOff.reintegrated).not.toMatch(/check/i);
    expect(MESSAGES.zh.guided.m3.signOff.reintegrated).not.toContain('检查');
  });

  test.each([
    ['passed', [{ ...gate, passed: true, exit_code: 0, stderr: '' }], en.m3.signOff.verificationPassed],
    ['failed', [gate], en.m3.signOff.verificationFailed],
    ['not_returned', undefined, en.m3.signOff.verificationNotReturned],
  ] as const)('a re-integration with %s gates shows that verification result', async (state, gates, label) => {
    await mount({ finalizer: vi.fn(async () => ({ ...approval(true), gates: gates as GateCommandResult[] | undefined })) });
    await click(en.signOff.approve);
    const verification = verificationBlock();
    assert(verification, 'Expected a verification result');
    expect(verification.state).toBe(state);
    expect(verification.markup).toContain(`${en.m3.signOff.verification}: ${label}`);
    expect(outcomeBlock().props['data-outcome']).toBe('reintegrated');
  });

  test('a plain merge ran no checks at merge time and shows no verification result', async () => {
    await mount();
    await click(en.signOff.approve);
    expect(outcomeBlock().props['data-outcome']).toBe('merged');
    expect(verificationBlock()).toBeNull();
  });
});

describe('merge outcomes', () => {
  test.each([false, true])('approval renders the %s reintegration state', async (reintegrated) => {
    const finalize = vi.fn(async () => approval(reintegrated));
    const finalized = vi.fn();
    await mount({ finalizer: finalize, onFinalized: finalized });
    await click(en.signOff.approve);
    expect(finalize).toHaveBeenCalledExactlyOnceWith('run-42', { action: 'approve' });
    expect(finalized).toHaveBeenCalledExactlyOnceWith(approval(reintegrated));
    expect(html()).toContain(`data-outcome="${reintegrated ? 'reintegrated' : 'merged'}"`);
    expect(html()).toContain(reintegrated ? en.m3.signOff.reintegrated : en.m3.signOff.merged);
    expect(html()).toContain(M);
    if (reintegrated) expect(html()).toContain('npm test');
  });

  test('integration conflicts list files and the reported base without announcing a merge', async () => {
    const finalizer = vi.fn(async () => { throw new ApiError(409, 'conflict', {
      code: 'INTEGRATION_CONFLICT', conflicts: ['src/conflict.ts'], base_head: LATER,
    }); });
    const finalized = vi.fn();
    await mount({ finalizer, onFinalized: finalized });
    await click(en.signOff.approve);
    expect(html()).toContain('data-outcome="conflict"');
    expect(html()).toContain('Nothing was merged.');
    expect(html()).toContain('src/conflict.ts');
    expect(html()).toContain(LATER);
    expect(html()).toContain(en.m3.drift.conflict);
    expect(finalized).not.toHaveBeenCalled();
  });

  test('gate failure lists the failed command and output and does not announce a merge', async () => {
    const finalizer = vi.fn(async () => { throw new ApiError(409, 'gate failed', { code: 'GATE_FAILED', gates: [gate] }); });
    const finalized = vi.fn();
    await mount({ finalizer, onFinalized: finalized });
    await click(en.signOff.approve);
    expect(html()).toContain('data-outcome="gate_failed"');
    expect(html()).toContain(en.m3.signOff.gateFailed);
    expect(html()).toContain('npm test');
    expect(html()).toContain('assertion failed');
    expect(html()).toContain(en.m3.drift.gateFailed);
    expect(finalized).not.toHaveBeenCalled();
    // "Not merged" and "Failed" are two separate results.
    expect(renderToStaticMarkup(outcomeBlock())).not.toContain('npm test');
    expect(verificationBlock()?.state).toBe('failed');
    expect(en.m3.signOff.gateFailed).not.toMatch(/check/i);
  });

  test('a base-moved 409 stays retryable and does not masquerade as superseded', async () => {
    await mount({ finalizer: vi.fn(async () => { throw new ApiError(409, 'moved', { code: 'BASE_MOVED' }); }) });
    await click(en.signOff.approve);
    expect(html()).toContain(en.m3.errors.BASE_MOVED);
    expect(button(en.signOff.approve).props.disabled).toBe(false);
    expect(html()).not.toContain(en.m3.errors.RUN_SUPERSEDED);
  });

  test('a malformed successful response makes the run read-only instead of retrying an ambiguous merge', async () => {
    const finalizer = vi.fn(async () => ({ ...approval(), merged_commit: undefined }));
    await mount({ finalizer });
    await click(en.signOff.approve);
    expect(html()).toContain('Refresh the run before retrying');
    expect(button(en.signOff.approve).props.disabled).toBe(true);
  });

  test('does not claim checks passed when a reintegration response omits its gates', async () => {
    await mount({ finalizer: vi.fn(async () => ({ ...approval(true), gates: undefined })) });
    await click(en.signOff.approve);
    expect(html()).toContain('response did not include check results');
    expect(html()).toContain('data-verification="not_returned"');
    expect(html()).not.toContain('data-verification="passed"');
  });

  test('an old run response cannot finalize the newly selected run', async () => {
    const pending = deferred<FinalizeResult>();
    const finalizer = vi.fn(() => pending.promise);
    const finalized = vi.fn();
    const rerender = await mount({ finalizer, onFinalized: finalized });
    await click(en.signOff.approve);
    await rerender({ runId: 'run-new' });
    await act(async () => { pending.resolve(approval()); await pending.promise; });
    expect(finalized).not.toHaveBeenCalled();
    expect(html()).not.toContain('data-outcome="merged"');
    expect(html()).toContain('run-new');
  });
});

describe('revision and lifecycle', () => {
  test('passes the original RFC and requested changes to the host Step 2 transition', async () => {
    let step = 'signoff';
    const transition = vi.fn(async () => { step = 'brainstorm'; return { run_id: 'run-42', status: 'SUPERSEDED' as const }; });
    const finalize = vi.fn(async () => approval());
    await mount({ onRequestRevision: transition, finalizer: finalize });
    await click(en.signOff.revise);
    const textarea = elements(view).find((node) => node.type === Textarea);
    assert(textarea);
    await act(async () => { (textarea.props.onChange as (event: unknown) => void)({ currentTarget: { value: '  Add coverage  ' } }); });
    await click(en.signOff.revise);
    expect(transition).toHaveBeenCalledExactlyOnceWith({ runId: 'run-42', prior_rfc: '# Original RFC\nKeep this scope',
      requested_changes: 'Add coverage' });
    expect(step).toBe('brainstorm');
    expect(finalize).not.toHaveBeenCalled();
    expect(html()).toContain(en.m3.errors.RUN_SUPERSEDED);
    expect(button(en.signOff.approve).props.disabled).toBe(true);
  });

  test('does not start a child run or claim navigation without a host revision transition and prior RFC', async () => {
    await mount({ onRequestRevision: undefined, priorRfc: undefined });
    expect(button(en.signOff.revise).props.disabled).toBe(true);
    expect(html()).toContain('Step 2 revision transition are required');
  });

  test.each(['RUN_SUPERSEDED', 'RUN_STALE'])('a %s 409 disables every sign-off mutation', async (code) => {
    const finalizer = vi.fn(async () => { throw new ApiError(409, 'changed', { code }); });
    await mount({ finalizer });
    await click(en.signOff.approve);
    expect(button(en.signOff.approve).props.disabled).toBe(true);
    expect(button(en.signOff.revise).props.disabled).toBe(true);
    expect(button(en.m3.rollback.abandonAll).props.disabled).toBe(true);
    expect(button(en.m3.rollback.revertRevision).props.disabled).toBe(true);
    expect(html()).toContain(code === 'RUN_STALE' ? en.m3.errors.RUN_STALE : en.m3.errors.RUN_SUPERSEDED);
  });

  test('SUPERSEDED and explicitly stale runs are read-only immediately', async () => {
    const rerender = await mount({ runStatus: 'SUPERSEDED' });
    expect(button(en.signOff.approve).props.disabled).toBe(true);
    expect(button(en.m3.rollback.abandonAll).props.disabled).toBe(true);
    await rerender({ runStatus: 'READY_FOR_FINAL_GATE', stale: true });
    expect(button(en.signOff.revise).props.disabled).toBe(true);
    expect(html()).toContain(en.m3.errors.RUN_STALE);
  });
});

describe('rollback', () => {
  test('only a run with a parent offers revision rollback; root still offers abandon', async () => {
    const rootLineage = { ...lineage, lineage: { ...lineage.lineage, parent_run_id: null, start_sha: A } };
    await mount({ lineage: rootLineage });
    expect(findButton(en.m3.rollback.revertRevision)).toBeUndefined();
    expect(button(en.m3.rollback.abandonAll).props.disabled).toBe(false);
  });

  test.each([
    ['revert_revision', en.m3.rollback.revertRevision, B],
    ['abandon_all', en.m3.rollback.abandonAll, A],
  ] as const)('%s requires an explicit confirmation naming its full target SHA', async (mode, label, target) => {
    const rollbacker = vi.fn(async (runId: string, selected: RollbackMode) => ({ ok: true as const, run_id: runId,
      mode: selected, status: 'PAUSED' as const, restored_to: target, base_branch: 'main', base_head: A }));
    const finalized = vi.fn();
    await mount({ rollbacker, onFinalized: finalized });
    await click(label);
    expect(rollbacker).not.toHaveBeenCalled();
    expect(confirmationHtml()).toContain(target);
    await click(en.m3.rollback.confirm);
    expect(rollbacker).toHaveBeenCalledExactlyOnceWith('run-42', mode);
    expect(finalized).toHaveBeenCalledWith(expect.objectContaining({ action: 'rollback', restored_to: target }));
    expect(html()).toContain(`${en.m3.rollback.restored}:`);
  });

  test('a missing target disables abandon instead of confirming a guessed SHA', async () => {
    await mount({ lineage: { ...lineage, rootStartSha: null } });
    expect(button(en.m3.rollback.abandonAll).props.disabled).toBe(true);
    expect(button(en.m3.rollback.revertRevision).props.disabled).toBe(false);
  });

  test('merged undo is offered only with reported matching HEAD and confirms the pre-merge SHA', async () => {
    const rollbacker = vi.fn(async (runId: string, mode: RollbackMode) => ({ ok: true as const, run_id: runId,
      mode, status: 'PAUSED' as const, restored_to: B, base_branch: 'main', base_head: B }));
    await mount({ runStatus: 'COMPLETED', lineage: mergedLineage, rollbacker });
    await click(en.m3.rollback.undo);
    expect(confirmationHtml()).toContain(B);
    expect(rollbacker).not.toHaveBeenCalled();
    await click(en.m3.rollback.confirm);
    expect(rollbacker).toHaveBeenCalledExactlyOnceWith('run-42', 'undo');
    expect(html()).toContain(`title="${C}"`);
    expect(html()).not.toContain('data-merged="true"');
  });

  test('undo after approval clears the merge outcome while retaining the run result SHA', async () => {
    const rollbacker = vi.fn(async (runId: string, mode: RollbackMode) => ({ ok: true as const, run_id: runId,
      mode, status: 'PAUSED' as const, restored_to: B, base_branch: 'main', base_head: B }));
    await mount({ rollbacker, lineageLoader: vi.fn(async () => mergedLineage) });
    await click(en.signOff.approve);
    expect(html()).toContain('data-outcome="merged"');
    await click(en.m3.rollback.undo);
    await click(en.m3.rollback.confirm);
    expect(html()).not.toContain('data-outcome="merged"');
    expect(html()).not.toContain('data-merged="true"');
    expect(html()).toContain(`title="${C}"`);
  });

  test('a legacy merged run uses its guarded finalize rollback after SHA confirmation', async () => {
    const legacy = { ...mergedLineage, lineage: { parent_run_id: null, base_ref: null, start_sha: null, result_sha: null } };
    const finalizer = vi.fn(async (): Promise<FinalizeResult> => ({ ok: true, run_id: 'run-42', action: 'rollback',
      status: 'PAUSED', backup_tag: 'baton-backup/run-42', restored_to: B, base_branch: 'main', base_head: B }));
    const rollbacker = vi.fn();
    await mount({ runStatus: 'COMPLETED', lineage: legacy, finalizer, rollbacker });
    await click(en.m3.rollback.undo);
    expect(confirmationHtml()).toContain(B);
    await click(en.m3.rollback.confirm);
    expect(finalizer).toHaveBeenCalledExactlyOnceWith('run-42', { action: 'rollback' });
    expect(rollbacker).not.toHaveBeenCalled();
  });

  test('an unknown HEAD uses the server guard; a known advanced HEAD shows guidance', async () => {
    const rerender = await mount({ runStatus: 'COMPLETED', lineage: { ...mergedLineage, currentBaseSha: null } });
    expect(button(en.m3.rollback.undo).props.disabled).not.toBe(true);
    expect(html()).toContain(en.m3.rollback.serverChecksHead);
    await rerender({ lineage: { ...mergedLineage, currentBaseSha: LATER,
      guidance: 'Review the later commits before reverting.', revertCommand: 'git revert -m 1 <merge-commit>' } });
    expect(findButton(en.m3.rollback.undo)).toBeUndefined();
    expect(html()).toContain('Review the later commits before reverting.');
    expect(html()).toContain('git revert -m 1 &lt;merge-commit&gt;');
  });

  test('a HEAD race returns backend guidance, closes confirmation and copies only its command template', async () => {
    const message = 'Review git log B..M; use git revert for the run. For a merge commit, use git revert -m 1 <merge-commit>; preserve later commits.';
    const rollbacker = vi.fn(async () => { throw new ApiError(409, 'advanced', { code: 'MERGE_NOT_HEAD',
      merged_commit: M, base_head: LATER, guidance: message }); });
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await mount({ runStatus: 'COMPLETED', lineage: mergedLineage, rollbacker });
    await click(en.m3.rollback.undo);
    await click(en.m3.rollback.confirm);
    expect(findButton(en.m3.rollback.undo)).toBeUndefined();
    expect(findButton(en.m3.rollback.confirm)).toBeUndefined();
    expect(html()).toContain('preserve later commits.');
    await click('Copy command template');
    expect(writeText).toHaveBeenCalledExactlyOnceWith('git revert -m 1 <merge-commit>');
  });

  test('a response targeting a different SHA is treated as stale rather than reported as confirmed', async () => {
    const finalized = vi.fn();
    const rollbacker = vi.fn(async (runId: string, mode: RollbackMode) => ({ ok: true as const, run_id: runId,
      mode, status: 'PAUSED' as const, restored_to: LATER, base_branch: 'main', base_head: A }));
    await mount({ rollbacker, onFinalized: finalized });
    await click(en.m3.rollback.abandonAll);
    await click(en.m3.rollback.confirm);
    expect(finalized).not.toHaveBeenCalled();
    expect(html()).toContain('did not match the confirmed target');
    expect(button(en.signOff.approve).props.disabled).toBe(true);
  });

  test('cancel leaves the run unchanged, and double submission starts only one rollback', async () => {
    const pending = deferred<{ ok: true; run_id: string; mode: RollbackMode; status: 'PAUSED'; restored_to: string;
      base_branch: string; base_head: string }>();
    const rollbacker = vi.fn(() => pending.promise);
    await mount({ rollbacker });
    await click(en.m3.rollback.abandonAll);
    await click(en.m3.rollback.cancel);
    expect(rollbacker).not.toHaveBeenCalled();
    await click(en.m3.rollback.abandonAll);
    const confirm = button(en.m3.rollback.confirm);
    await act(async () => {
      (confirm.props.onClick as () => void)();
      (confirm.props.onClick as () => void)();
    });
    expect(rollbacker).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve({ ok: true, run_id: 'run-42', mode: 'abandon_all', status: 'PAUSED',
      restored_to: A, base_branch: 'main', base_head: A }); await pending.promise; });
  });

  test('a changed target invalidates an already displayed confirmation', async () => {
    const rollbacker = vi.fn();
    const rerender = await mount({ rollbacker });
    await click(en.m3.rollback.abandonAll);
    expect(confirmationHtml()).toContain(A);
    await rerender({ lineage: { ...lineage, rootStartSha: LATER } });
    expect(button(en.m3.rollback.confirm).props.disabled).toBe(true);
    expect(rollbacker).not.toHaveBeenCalled();
  });

  test('rechecks the server target and result after confirmation before sending rollback', async () => {
    const rollbacker = vi.fn();
    const lineageLoader = vi.fn(async () => ({ ...lineage, rootStartSha: LATER }));
    await mount({ rollbacker, lineageLoader });
    await click(en.m3.rollback.abandonAll);
    expect(confirmationHtml()).toContain(A);
    await click(en.m3.rollback.confirm);
    expect(lineageLoader).toHaveBeenCalledExactlyOnceWith('run-42');
    expect(rollbacker).not.toHaveBeenCalled();
    expect(button(en.signOff.approve).props.disabled).toBe(true);
    expect(html()).toContain('changed after confirmation');
  });
});

describe('lineage loading', () => {
  test('loads ancestors and uses the root start for abandon rather than the parent result', async () => {
    vi.spyOn(BatonApiClient.prototype, 'init').mockResolvedValue('local');
    const getRun = vi.spyOn(BatonApiClient.prototype, 'getLineageRun').mockImplementation(async (id) => ({
      run: id === 'run-42'
        ? { id, status: 'READY_FOR_FINAL_GATE', ...lineage.lineage }
        : { id, status: 'SUPERSEDED', parent_run_id: null, base_ref: 'main', start_sha: A, result_sha: B },
      events: [], milestones: [], tasks: [], quotas: [],
    } as never));
    await mount({ lineage: undefined, lineageLoader: undefined });
    expect(getRun).toHaveBeenCalledTimes(2);
    expect(html()).toContain(`title="${A}"`);
    await click(en.m3.rollback.abandonAll);
    expect(confirmationHtml()).toContain(A);
  });

  test('a malformed chain disables SHA-dependent actions and shows a read error', async () => {
    vi.spyOn(BatonApiClient.prototype, 'init').mockResolvedValue('local');
    vi.spyOn(BatonApiClient.prototype, 'getLineageRun').mockResolvedValue({
      run: { id: 'run-42', status: 'READY_FOR_FINAL_GATE', ...lineage.lineage, parent_run_id: 'run-42' },
      events: [], milestones: [], tasks: [], quotas: [],
    } as never);
    await mount({ lineage: undefined, lineageLoader: undefined });
    expect(html()).toContain('Could not load run lineage');
    expect(button(en.signOff.approve).props.disabled).toBe(true);
    expect(button(en.m3.rollback.abandonAll).props.disabled).toBe(true);
  });
});
