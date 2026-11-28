import { act, Children, createElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, assert, describe, expect, test, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { I18nProvider } from '../../i18n';
import { MESSAGES } from '../../i18n/messages';
import { Textarea } from '../ui/input';
import { GuidedDecisionDrawer, type GuidedDecisionDrawerProps } from './GuidedDecisionDrawer';
import { useGuidedDecisionContent } from './GuidedDecisionModal';

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) => isValidElement<Record<string, unknown>>(child)
    ? [child, ...elements(child.props.children as ReactNode)] : []);
}

let root: Root | undefined;
let view: ReactNode;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

async function mountForm(props: GuidedDecisionDrawerProps) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', { HTMLIFrameElement: class HTMLIFrameElement {} });
  const container = { nodeType: 1, tagName: 'DIV', ownerDocument: null, addEventListener() {} };
  root = createRoot(container as unknown as HTMLElement);
  function Probe() { view = useGuidedDecisionContent(props); return null; }
  await act(async () => { root!.render(createElement(Probe)); });
}

const props: GuidedDecisionDrawerProps = {
  open: true, runId: 'run-1', taskId: 'T1', question: 'Review the RFC', options: [],
  locale: 'en', onResolved: () => {},
};

describe('GuidedDecisionDrawer', () => {
  test('renders a labelled non-modal side panel with the shared decision form', () => {
    const html = renderToStaticMarkup(createElement(I18nProvider, { children: createElement(GuidedDecisionDrawer, props) }));
    expect(html).toContain('<aside');
    expect(html).toContain('guided-decision-drawer');
    expect(html).toContain('aria-labelledby=');
    expect(html).toContain('Review the');
    expect(html).toContain('type="radio"');
    expect(html).not.toContain('<dialog');
    expect(html).not.toContain('aria-modal');
    expect(html).not.toContain('scrim');
    expect(renderToStaticMarkup(createElement(GuidedDecisionDrawer, { ...props, open: false }))).toBe('');
  });

  test.each([
    ['en', 'Task T3 needs a decision from you', 'Reply to task T3'],
    ['zh', '任务 T3 需要你做一个决定', '回复任务 T3'],
  ] as const)('in the context drawer the heading and the submit button name the task (%s)', (locale, heading, button) => {
    const relay = MESSAGES[locale].guided.relay;
    expect([relay.decisionTitle('T3'), relay.replyToTask('T3')]).toEqual([heading, button]);
    const html = renderToStaticMarkup(createElement(I18nProvider, { children: createElement(GuidedDecisionDrawer, {
      ...props, locale, taskId: 'T3', title: relay.decisionTitle('T3'), submitLabel: relay.replyToTask('T3'),
    }) }));
    expect(html).toContain(`>${heading}</h2>`);
    expect(html).toMatch(new RegExp(`<button[^>]*type="submit"[^>]*>${button}</button>`));
    expect(html).not.toContain(MESSAGES[locale].guided.decision.submit);
  });

  test('the shared form submits once, trims the note, and reports stale runs', async () => {
    let reject!: (reason: unknown) => void;
    const resolver = vi.fn(() => new Promise<unknown>((_resolve, fail) => { reject = fail; }));
    const onStale = vi.fn();
    const onResolved = vi.fn();
    await mountForm({ ...props, resolver, onStale, onResolved });
    const option = elements(view).find((node) => node.type === 'input' && node.props.value === 'approve');
    assert(option);
    await act(async () => { (option.props as ComponentProps<'input'>).onChange!({} as never); });
    const note = elements(view).find((node) => node.type === Textarea);
    assert(note);
    await act(async () => { (note.props as ComponentProps<typeof Textarea>).onChange!({ currentTarget: { value: '  a note  ' } } as never); });
    const form = elements(view).find((node) => node.type === 'form');
    assert(form);
    const submit = (form.props as ComponentProps<'form'>).onSubmit!;
    await act(async () => { submit({ preventDefault() {} } as never); submit({ preventDefault() {} } as never); });
    expect(resolver).toHaveBeenCalledOnce();
    expect(resolver).toHaveBeenCalledWith({ runId: 'run-1', taskId: 'T1', choice: 'approve', note: 'a note' });
    await act(async () => { reject(new ApiError(409, 'superseded', { code: 'RUN_SUPERSEDED' })); });
    expect(onStale).toHaveBeenCalledOnce();
    expect(onResolved).not.toHaveBeenCalled();
  });
});
