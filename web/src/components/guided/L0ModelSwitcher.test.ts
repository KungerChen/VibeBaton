import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { MESSAGES } from '../../i18n/messages';
import { Button } from '../ui/button';
import { Select } from '../ui/input';
import {
  L0ModelSwitcher,
  type L0ModelSwitcherOption,
  type L0ModelSwitcherProps,
} from './L0ModelSwitcher';

vi.mock('../ui/button', () => ({
  Button: vi.fn(({ children, variant: _variant, size: _size, ...props }: ComponentProps<typeof Button>) =>
    createElement('button', props, children)),
}));

vi.mock('../ui/input', () => ({
  Select: vi.fn(({ children, ...props }: ComponentProps<typeof Select>) =>
    createElement('select', props, children)),
}));

const MODELS: L0ModelSwitcherOption[] = [
  {
    provider: 'codex_sub',
    model: 'gpt-test',
    effort: 'high',
    spec: 'codex_sub:gpt-test@high',
    label: 'GPT Test',
  },
  {
    provider: 'claude_sub',
    model: 'claude-test',
    effort: 'high',
    spec: 'claude_sub:claude-test@high',
    label: 'Claude Test',
    ready: false,
    reason: 'Sign in <required>',
  },
  {
    provider: 'gemini_sub',
    model: 'gemini-test',
    effort: 'medium',
    spec: 'gemini_sub:gemini-test@medium',
    label: 'Gemini Test',
    ready: true,
  },
];
const RECOMMENDED = MODELS[0].spec;

const baseProps: L0ModelSwitcherProps = {
  models: MODELS,
  selected: null,
  autoSelected: RECOMMENDED,
  loading: false,
  onChange: () => {},
  onRetry: () => {},
};

function renderSwitcher(locale: 'en' | 'zh', props: Partial<L0ModelSwitcherProps> = {}): string {
  vi.stubGlobal('window', { localStorage: { getItem: () => locale } });
  return renderToStaticMarkup(createElement(I18nProvider, {
    children: createElement(L0ModelSwitcher, { ...baseProps, ...props }),
  }));
}

function optionTag(html: string, spec: string): string {
  const valueAt = html.indexOf(`value="${spec}"`);
  return html.slice(html.lastIndexOf('<option', valueAt), html.indexOf('>', valueAt) + 1);
}

afterEach(() => {
  vi.mocked(Button).mockClear();
  vi.mocked(Select).mockClear();
  vi.unstubAllGlobals();
});

describe('L0ModelSwitcher', () => {
  test.each(['en', 'zh'] as const)('renders the current, recommended and unavailable models in %s', (locale) => {
    const copy = MESSAGES[locale].guided.m3.l0Model;
    const html = renderSwitcher(locale);
    expect(html).toContain(copy.label);
    expect(html).toContain(copy.selected);
    expect(html).toContain(copy.auto);
    expect(html).toContain(MODELS[0].label);
    expect(html).toContain(MODELS[1].label);
    expect(html).toContain(`<strong>${copy.auto} — ${MODELS[0].label}</strong>`);
    expect(optionTag(html, RECOMMENDED)).toContain('data-recommended="true"');
    expect(optionTag(html, RECOMMENDED)).not.toContain('disabled');
    expect(html.replaceAll('<!-- -->', '')).toContain(
      `${MODELS[0].label} · ${MESSAGES[locale].guided.setup.presetRecommended}`,
    );
    expect(optionTag(html, MODELS[2].spec)).not.toContain('disabled');
    const unavailable = optionTag(html, MODELS[1].spec);
    expect(unavailable).toContain('disabled=""');
    expect(unavailable).toContain('title="Sign in &lt;required&gt;"');
    expect(html).toContain('Sign in &lt;required&gt;');
    expect(vi.mocked(Select).mock.lastCall?.[0].value).toBe('');
  });

  test('reports the chosen spec, clears to automatic mode, and ignores unavailable models', () => {
    const onChange = vi.fn();
    const html = renderSwitcher('en', { selected: RECOMMENDED, onChange });
    const props = vi.mocked(Select).mock.lastCall?.[0];
    expect(props?.value).toBe(RECOMMENDED);
    expect(html).toContain(`<strong>${MODELS[0].label}</strong>`);

    props?.onChange?.({ currentTarget: { value: MODELS[2].spec } } as never);
    expect(onChange).toHaveBeenLastCalledWith(MODELS[2].spec);
    props?.onChange?.({ currentTarget: { value: '' } } as never);
    expect(onChange).toHaveBeenLastCalledWith(null);
    props?.onChange?.({ currentTarget: { value: MODELS[1].spec } } as never);
    props?.onChange?.({ currentTarget: { value: 'gone:model@high' } } as never);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  test('does not recommend a model that is no longer ready', () => {
    const html = renderSwitcher('en', { autoSelected: MODELS[1].spec });
    expect(optionTag(html, MODELS[1].spec)).toContain('disabled=""');
    expect(html).not.toContain('data-recommended="true"');
    expect(html).toContain(`<strong>${MESSAGES.en.guided.m3.l0Model.auto}</strong>`);
  });

  test.each(['en', 'zh'] as const)('shows a truthful fallback when an unavailable model has no reason in %s', (locale) => {
    const model = { ...MODELS[1], reason: null };
    const html = renderSwitcher(locale, { models: [MODELS[0], model] });
    expect(html).toContain(MESSAGES[locale].guided.setup.scanSummary(0, 1));
    expect(optionTag(html, model.spec)).toContain('disabled=""');
    expect(html).not.toContain(MESSAGES[locale].guided.m3.l0Model.unavailable);
  });

  test('keeps a selection that is no longer listed visible and unavailable', () => {
    const html = renderSwitcher('en', { selected: 'gone:model@high' });
    expect(html).toContain('<strong>gone:model@high</strong>');
    expect(optionTag(html, 'gone:model@high')).toContain('disabled=""');
  });

  test('keeps a selected but unready model visible with its reason', () => {
    const html = renderSwitcher('en', { selected: MODELS[1].spec });
    expect(vi.mocked(Select).mock.lastCall?.[0].value).toBe(MODELS[1].spec);
    expect(html).toContain(`<strong>${MODELS[1].label}</strong>`);
    expect(optionTag(html, MODELS[1].spec)).toContain('disabled=""');
    expect(html).toContain('Sign in &lt;required&gt;');
  });

  test('does not make API calls', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    renderSwitcher('en');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('shows the empty message when every listed model is unavailable', () => {
    const html = renderSwitcher('en', { models: [MODELS[1]] });
    expect(html).toContain(MESSAGES.en.guided.m3.l0Model.unavailable);
    expect(optionTag(html, MODELS[1].spec)).toContain('disabled=""');
    expect(html).not.toContain('data-recommended="true"');
  });

  test('shows loading, failure with retry, and the empty state', () => {
    const copy = MESSAGES.en.guided.m3.l0Model;
    let html = renderSwitcher('en', { models: [], loading: true });
    expect(html).toContain(copy.loading);
    expect(vi.mocked(Select).mock.lastCall?.[0].disabled).toBe(true);

    const onRetry = vi.fn();
    html = renderSwitcher('en', { models: [], error: 'Scan <failed>', onRetry });
    expect(html).toContain(copy.failed);
    expect(html).toContain('Scan &lt;failed&gt;');
    expect(html).toContain(copy.retry);
    expect(vi.mocked(Select).mock.lastCall?.[0].disabled).toBe(true);
    vi.mocked(Button).mock.lastCall?.[0].onClick?.({} as never);
    expect(onRetry).toHaveBeenCalledOnce();

    html = renderSwitcher('en', { models: [] });
    expect(html).toContain(copy.unavailable);
    expect(html).not.toContain(copy.failed);
  });
});

/*
 * Implementation record: 20261126-134112-m3-r3 (PST, baton/e33e97/m3-r3, base 1efb078).
 * Revised the previous attempt's three untracked files within the whitelist;
 * the parent supplies model readiness, reasons and the automatic selection.
 * Eleven targeted tests passed with --configLoader runner; typecheck passed.
 * The exact test command failed before tests with EPERM on shared node_modules.
 * Browser access and an isolated verification script were blocked by policy.
 * Self-tested, pending user acceptance; real UI remains unverified. The API currently
 * returns only ready models; a parent must supply any unready options and reasons.
 * No commit or backup of the previous untracked files was created in this round.
 */
