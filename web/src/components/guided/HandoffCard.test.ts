import { act, Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, assert, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiError, type RunArtifactResponse, type RunHandoff } from '../../api/client';
import { MESSAGES } from '../../i18n/messages';
import { HandoffCard, type HandoffCardProps } from './HandoffCard';

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) => isValidElement<Record<string, unknown>>(child)
    ? [child, ...elements(child.props.children as ReactNode)] : []);
}

function text(node: ReactNode): string {
  return Children.toArray(node).map((child) => typeof child === 'string' || typeof child === 'number' ? String(child)
    : isValidElement<Record<string, unknown>>(child) ? text(child.props.children as ReactNode) : '').join('');
}

const recorded: RunHandoff = {
  id: 'task:T1>milestone:M1',
  from: { kind: 'task', id: 'T1' },
  to: { kind: 'milestone', id: 'M1' },
  recorded: true,
  event_ids: [41],
  at: 1_700_000_000,
  invocations: [
    { event_id: 12, artifact_key: 'T1_critical_executor_1', role: 'critical_executor', model: 'sonnet', side: 'from',
      created_at: 1_699_999_000, status: 'ok', duration_sec: 90 },
    { event_id: 13, artifact_key: null, role: 'micro_orchestrator', model: 'flash', side: 'from',
      created_at: 1_699_999_100, status: null, duration_sec: null },
  ],
  changed_files: ['src/app.py', 'tests/test_app.py'],
  receipts: [
    { event_id: 20, scope: 'task', target_id: 'T1', command: 'python -m unittest', exit_code: 0, passed: true,
      duration_sec: 1.5, output_tail: 'OK (3 tests)', created_at: 1_699_999_200 },
    { event_id: 21, scope: 'merge', target_id: 'task_T1', command: 'npm test', exit_code: 2, passed: true,
      duration_sec: 3, output_tail: '1 failing', created_at: 1_699_999_300 },
  ],
  review: { verdict: 'PASS', summary: 'Looks complete.', reviewer: 'micro_orchestrator:flash', event_id: 30 },
  takeover: { status: 'RUNNING', holder: 'milestone_reviewer' },
  blocked_reason: null,
};

const unrecorded: RunHandoff = {
  id: 'milestone:M1>final_gate', from: { kind: 'milestone', id: 'M1' }, to: { kind: 'final_gate', id: null },
  recorded: false, event_ids: [], at: null, invocations: [], changed_files: null, receipts: [], review: null,
  takeover: { status: null, holder: null }, blocked_reason: null,
};

function props(overrides: Partial<HandoffCardProps> = {}): HandoffCardProps {
  return { runId: 'r1', handoff: recorded, fromLabel: 'T1 · Write', toLabel: 'M1 · Core', locale: 'en',
    loadArtifact: vi.fn(), ...overrides };
}

/** The part of the card shown before the technical details are expanded. */
function upperPart(html: string): string {
  const index = html.indexOf('context-drawer__details');
  return index < 0 ? html : html.slice(0, index);
}

let root: Root | undefined;
beforeEach(() => { vi.stubGlobal('window', { HTMLIFrameElement: class HTMLIFrameElement {}, localStorage:{ getItem: () => null, setItem: () => {} } }); });
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('HandoffCard', () => {
  test('a recorded handoff shows each recorded value', () => {
    const copy = MESSAGES.en.guided.relay.handoff;
    const html = renderToStaticMarkup(createElement(HandoffCard, props()));
    const time = new Date(1_700_000_000 * 1000).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'medium' });
    expect(upperPart(html)).toContain('T1 · Write');
    expect(upperPart(html)).toContain('M1 · Core');
    expect(upperPart(html)).toContain(copy.recorded(time));
    expect(upperPart(html)).toContain(copy.recordedSummary('T1 · Write', 'M1 · Core'));
    expect(html).not.toContain(copy.unknownStatus);
    // Deliverables: who, role, model, result and time spent.
    expect(html).toContain(copy.sides.from);
    expect(html).toContain('L2 Critical Executor');
    expect(html).toContain('sonnet');
    expect(html).toContain('1m 30s');
    expect(html).toContain(copy.viewPrompt);
    expect(html).toContain(copy.viewOutput);
    // Changed files, gate receipts by exit code, review and takeover.
    expect(html).toContain('src/app.py');
    expect(html).toContain('tests/test_app.py');
    expect(html).toContain('python -m unittest');
    expect(html).toContain(copy.exitCode(0));
    expect(html).toContain('npm test');
    expect(html).toContain(copy.exitCode(2));
    expect(html).toMatch(/data-passed="true"[^>]*>[^<]*<code>python -m unittest/);
    expect(html).toMatch(/data-passed="false"[^>]*>[^<]*<code>npm test/);
    expect(html).toContain('OK (3 tests)');
    expect(html).toContain(copy.scopes.merge);
    expect(html).toContain('Looks complete.');
    expect(html).toContain('micro_orchestrator:flash');
    expect(html).toContain(MESSAGES.en.guided.nodeDetail.verdicts.PASS);
    expect(html).toContain(MESSAGES.en.guided.nodeDetail.statuses.RUNNING);
    expect(html).toContain('L1 Milestone Reviewer');
    expect(html).toContain(copy.noBlocked);
  });

  test('a failing receipt says failed even when its own passed flag says otherwise', () => {
    const copy = MESSAGES.en.guided.relay.handoff;
    const html = renderToStaticMarkup(createElement(HandoffCard, props({
      handoff: { ...recorded, receipts: [recorded.receipts[1]] },
    })));
    expect(html).toContain(copy.receiptFailed);
    expect(html).not.toContain(copy.receiptPassed);
  });

  test.each(['en', 'zh'] as const)('an unrecorded handoff says unknown for every missing item (%s)', (locale) => {
    const relay = MESSAGES[locale].guided.relay;
    const html = renderToStaticMarkup(createElement(HandoffCard, props({ handoff: unrecorded, locale,
      fromLabel: 'M1', toLabel: 'Gate' })));
    expect(upperPart(html)).toContain(relay.handoff.unknownStatus);
    expect(upperPart(html)).toContain(relay.handoff.unknownSummary);
    for (const field of ['deliverables', 'changed-files', 'review', 'takeover-status', 'takeover-holder']) {
      expect(html, field).toContain(`data-field="${field}">${relay.unknown}<`);
    }
    expect(html).toContain(relay.handoff.noReceipts);
    expect(html).toContain(`data-field="blocked">${relay.handoff.noBlocked}<`);
    expect(html).not.toContain(relay.handoff.receiptPassed);
    expect(html).not.toContain('data-passed="true"');
  });

  test('a handoff the server did not list (a panel line) is unknown too', () => {
    const html = renderToStaticMarkup(createElement(HandoffCard, props({ handoff: null, fromLabel: 'Synthesizer', toLabel: 'Plan' })));
    expect(upperPart(html)).toContain(MESSAGES.en.guided.relay.handoff.unknownStatus);
    expect(html).toContain(`data-field="changed-files">${MESSAGES.en.guided.relay.unknown}<`);
    expect(html).not.toContain(MESSAGES.en.guided.relay.handoff.receiptPassed);
  });

  test('an empty change list is not unknown', () => {
    const html = renderToStaticMarkup(createElement(HandoffCard, props({ handoff: { ...recorded, changed_files: [] } })));
    expect(html).toContain(`data-field="changed-files">${MESSAGES.en.guided.relay.handoff.noChangedFiles}<`);
  });

  test('prompts and outputs load only when asked; 404 and empty parts read "Not recorded"', async () => {
    const copy = MESSAGES.en.guided.relay;
    let view: ReactNode;
    let finish!: (value: RunArtifactResponse) => void;
    const loadArtifact = vi.fn((key: string) => key === 'T1_critical_executor_1'
      ? new Promise<RunArtifactResponse>((resolve) => { finish = resolve; })
      : Promise.reject(new ApiError(404, 'not found')));
    const handoff: RunHandoff = { ...recorded, invocations: [...recorded.invocations,
      { ...recorded.invocations[0], event_id: 14, artifact_key: 'T1_gone', side: 'to' }] };
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = { nodeType: 1, tagName: 'DIV', ownerDocument: null, addEventListener() {} };
    root = createRoot(container as unknown as HTMLElement);
    function Probe() { view = HandoffCard(props({ handoff, loadArtifact })); return null; }
    await act(async () => { root!.render(createElement(Probe)); });
    expect(loadArtifact).not.toHaveBeenCalled();

    const calls = () => elements(view).filter((node) => node.props['data-field'] === 'invocation');
    const button = (index: number, label: string) => {
      const found = elements(calls()[index].props.children as ReactNode).find((node) => node.type === 'button' && text(node.props.children as ReactNode) === label);
      assert(found, `Expected ${label} on invocation ${index}`);
      return found;
    };
    // The call without an artifact key has nothing to open.
    expect(elements(calls()[1].props.children as ReactNode).some((node) => node.type === 'button')).toBe(false);
    expect(text(calls()[1])).toContain(copy.notRecorded);

    await act(async () => { (button(0, copy.handoff.viewPrompt).props.onClick as () => void)(); });
    expect(loadArtifact).toHaveBeenCalledWith('T1_critical_executor_1');
    expect(text(calls()[0])).toContain(copy.handoff.loading);
    await act(async () => { finish({ run_id: 'r1', artifact_key: 'T1_critical_executor_1',
      prompt: { text: 'Write the app', truncated: true, bytes: 900_000 }, output: null }); });
    expect(text(calls()[0])).toContain('Write the app');
    expect(text(calls()[0])).toContain(copy.handoff.truncated);

    await act(async () => { (button(0, copy.handoff.viewOutput).props.onClick as () => void)(); });
    expect(loadArtifact).toHaveBeenCalledOnce();
    expect(text(calls()[0])).toContain(copy.notRecorded);
    expect(text(calls()[0])).not.toContain('Write the app');

    await act(async () => { (button(2, copy.handoff.viewPrompt).props.onClick as () => void)(); });
    expect(loadArtifact).toHaveBeenLastCalledWith('T1_gone');
    expect(text(calls()[2])).toContain(copy.notRecorded);
  });
});
