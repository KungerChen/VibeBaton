import { act, Children, createElement, isValidElement } from 'react';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, assert, describe, expect, test, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { MESSAGES } from '../../i18n/messages';
import { Button } from '../ui/button';
import { Textarea } from '../ui/input';
import { Modal } from '../ui/Modal';
import {
  buildResolvePayload,
  GuidedDecisionModal,
  optionsFromEvent,
  type GuidedDecisionModalProps,
  type GuidedDecisionOption,
} from './GuidedDecisionModal';

vi.mock('../ui/Modal', () => ({ Modal: vi.fn(() => null) }));

const OPTIONS: GuidedDecisionOption[] = [
  {
    id: 'approve',
    label_en: 'Ship it',
    label_zh: '发布',
    hint_en: 'Merge the change.',
    hint_zh: '合并这次改动。',
  },
  {
    id: 'reject',
    label_en: 'Send it back',
    label_zh: '退回',
    hint_en: 'Ask the team for changes.',
    hint_zh: '请团队继续修改。',
  },
];

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) => isValidElement<Record<string, unknown>>(child)
    ? [child, ...elements(child.props.children as ReactNode)]
    : []);
}

function createTestRoot(): Root {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', { HTMLIFrameElement: class HTMLIFrameElement {} });
  const container = { nodeType: 1, tagName: 'DIV', ownerDocument: null, addEventListener() {} };
  return createRoot(container as unknown as HTMLElement);
}

let root: Root | undefined;

afterEach(() => {
  try {
    act(() => root?.unmount());
  } finally {
    root = undefined;
    vi.unstubAllGlobals();
    vi.mocked(Modal).mockClear();
  }
});

async function mount(props: GuidedDecisionModalProps): Promise<void> {
  root = createTestRoot();
  await act(async () => {
    root!.render(createElement(I18nProvider, { children: createElement(GuidedDecisionModal, props) }));
  });
}

function modalContent(): ReactNode {
  return vi.mocked(Modal).mock.lastCall?.[0].children;
}

function findNode(predicate: (node: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>> {
  const found = elements(modalContent()).find(predicate);
  assert(found, 'Expected the modal to render a matching node');
  return found;
}

function markup(): string {
  return renderToStaticMarkup(createElement(I18nProvider, { children: modalContent() }));
}

describe('buildResolvePayload', () => {
  test('builds the resolver payload and trims the note', () => {
    expect(buildResolvePayload('run-1', 'M1-T2', 'approve', '  Keep the friendly tone  ')).toEqual({
      runId: 'run-1',
      taskId: 'M1-T2',
      choice: 'approve',
      note: 'Keep the friendly tone',
    });
  });

  test('defaults an omitted note to an empty string', () => {
    expect(buildResolvePayload('run-1', 'M1-T2', 'reject')).toEqual({
      runId: 'run-1',
      taskId: 'M1-T2',
      choice: 'reject',
      note: '',
    });
  });
});

describe('optionsFromEvent', () => {
  test('falls back to approve and reject when the event carries no options', () => {
    const events = [
      undefined,
      null,
      {},
      { kind: 'human_attention_required', message: 'Human decision required' },
      { payload: { category: 'waiting_human', title: 'Human decision required' } },
      { payload_json: '{"category":"waiting_human"}' },
      { payload_json: '{not json' },
    ];
    for (const event of events) {
      expect(optionsFromEvent(event).map(({ id }) => id)).toEqual(['approve', 'reject']);
    }
  });

  test('maps bilingual options from event rows and decoded or JSON payloads', () => {
    expect(optionsFromEvent({ options: OPTIONS })).toEqual(OPTIONS);
    expect(optionsFromEvent({ payload: { category: 'waiting_human', options: OPTIONS } })).toEqual(OPTIONS);
    expect(optionsFromEvent({
      kind: 'human_attention_required',
      payload_json: JSON.stringify({ category: 'waiting_human', options: OPTIONS }),
    })).toEqual(OPTIONS);
  });

  test('drops choices the /resolve endpoint would reject, falling back to defaults when none remain', () => {
    expect(optionsFromEvent({
      options: [
        { id: 'retry', label_en: 'Retry' },
        { id: 'reject', label_en: 'Send it back' },
        { id: 'skip', label_en: 'Skip' },
      ],
    }).map(({ id }) => id)).toEqual(['reject']);
    expect(optionsFromEvent({ options: [{ id: 'retry', label_en: 'Retry' }] }).map(({ id }) => id))
      .toEqual(['approve', 'reject']);
  });

  test('skips malformed entries and fills missing translations', () => {
    expect(optionsFromEvent({
      options: [
        { id: '', label_en: 'Blank' },
        { id: ' approve ', label_en: ' Ship it ', hint_en: ' Merge. ' },
      ],
    })).toEqual([
      {
        id: 'approve',
        label_en: 'Ship it',
        label_zh: 'Ship it',
        hint_en: 'Merge.',
        hint_zh: 'Merge.',
      },
    ]);
  });
});

describe('GuidedDecisionModal', () => {
  test('renders highlighted question text and radio choice cards', async () => {
    await mount({
      open: true,
      runId: 'run-1',
      taskId: 'M2-T10',
      question: 'The RFC needs your call on this task.',
      options: OPTIONS,
      onResolved: vi.fn(),
      locale: 'en',
    });

    const copy = MESSAGES.en.guided.decision;
    const html = markup();
    expect(vi.mocked(Modal).mock.lastCall?.[0].title).toBe(copy.title);
    expect(html).toContain(copy.intro);
    expect(html).toContain(copy.noteLabel);
    expect(html).toContain(copy.submit);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('type="radio"');
    expect(html).toContain('class="glossary-term__trigger"');
    expect(html).toContain(OPTIONS[0].label_en);
    expect(html).toContain(OPTIONS[0].hint_en);
    const submitButton = elements(modalContent()).find((node) => node.type === Button && node.props.type === 'submit');
    expect(submitButton?.props.disabled).toBe(true);
  });

  test('shows only the default approve/reject cards when no options are supplied', async () => {
    await mount({
      open: true,
      runId: 'run-1',
      taskId: 'M2-T10',
      question: 'The RFC needs your call on this task.',
      options: [],
      onResolved: vi.fn(),
      locale: 'en',
    });

    const html = markup();
    expect(html).toContain('Approve');
    expect(html).toContain('Reject');
    expect(html).not.toContain('Retry');
  });

  test('submits exactly one resolve payload and reports resolution once', async () => {
    let release!: () => void;
    const resolver = vi.fn(() => new Promise<unknown>((resolve) => {
      release = () => resolve({ ok: true });
    }));
    const onResolved = vi.fn();
    await mount({
      open: true,
      runId: 'run-42',
      taskId: 'M2-T10',
      question: 'The RFC needs your call on this task.',
      options: OPTIONS,
      onResolved,
      locale: 'en',
      resolver,
    });

    const approve = findNode((node) => node.type === 'input' && node.props.value === 'approve');
    const onChoice = (approve.props as ComponentProps<'input'>).onChange;
    assert(onChoice, 'Expected the approve radio change handler');
    await act(async () => {
      onChoice({} as never);
    });

    const textarea = findNode((node) => node.type === Textarea);
    const onNote = (textarea.props as ComponentProps<typeof Textarea>).onChange;
    assert(onNote, 'Expected the note change handler');
    await act(async () => {
      onNote({ currentTarget: { value: 'Keep the friendly tone' } } as never);
    });

    const form = findNode((node) => node.type === 'form');
    const onSubmit = (form.props as ComponentProps<'form'>).onSubmit;
    assert(onSubmit, 'Expected the decision form submit handler');
    const submitEvent = { preventDefault: vi.fn() } as never;

    await act(async () => {
      onSubmit(submitEvent);
    });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith({
      runId: 'run-42',
      taskId: 'M2-T10',
      choice: 'approve',
      note: 'Keep the friendly tone',
    });
    expect(onResolved).not.toHaveBeenCalled();

    await act(async () => {
      onSubmit(submitEvent);
    });
    expect(resolver).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
      await Promise.resolve();
    });
    expect(onResolved).toHaveBeenCalledTimes(1);
  });
});
