import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { MESSAGES } from '../../i18n/messages';
import { Button } from '../ui/button';
import { WorkflowSwitchPill, type WorkflowSwitchPillProps } from './WorkflowSwitchPill';

vi.mock('../ui/button', () => ({
  Button: vi.fn(({ children, variant: _variant, size: _size, ...props }: ComponentProps<typeof Button>) =>
    createElement('button', props, children)),
}));

function baseProps(overrides: Partial<WorkflowSwitchPillProps> = {}): WorkflowSwitchPillProps {
  return {
    currentSize: 'medium',
    recommendedSize: 'large',
    onSwitch: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
}

function renderPill(locale: 'en' | 'zh', overrides: Partial<WorkflowSwitchPillProps> = {}): string {
  vi.stubGlobal('window', { localStorage: { getItem: () => locale } });
  return renderToStaticMarkup(createElement(I18nProvider, {
    children: createElement(WorkflowSwitchPill, baseProps(overrides)),
  }));
}

function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function idRef(html: string, attribute: string): string | null {
  return new RegExp(`${attribute}="([^"]+)"`).exec(html)?.[1] ?? null;
}

afterEach(() => {
  vi.mocked(Button).mockClear();
  vi.unstubAllGlobals();
});

describe('WorkflowSwitchPill', () => {
  test.each(['en', 'zh'] as const)('renders the localized size change and both actions in %s', (locale) => {
    const copy = MESSAGES[locale].guided.m3.workflowSwitch;
    const recommendation = MESSAGES[locale].guided.m3.recommendation;
    const html = renderPill(locale, { recommendedMode: 'panel' });
    const text = visibleText(html);
    const labelId = idRef(html, 'aria-labelledby');

    expect(labelId).not.toBeNull();
    expect(html).toContain(`id="${labelId}"`);
    expect(html).toContain('data-current-size="medium"');
    expect(html).toContain('data-recommended-size="large"');
    expect(html).toContain('data-recommended-mode="panel"');
    expect(text).toContain(copy.label);
    expect(text).toContain(recommendation.sizeChanged);
    expect(text).toContain(recommendation.medium);
    expect(text).toContain(recommendation.large);
    expect(text).toContain(copy.panel);
    expect(text).toContain(copy.switchToPanel);
    expect(text).toContain(copy.dismiss);
    expect(vi.mocked(Button)).toHaveBeenCalledTimes(2);
  });

  test('renders nothing when the sizes match or either size is unknown', () => {
    const unchanged = [
      { currentSize: 'small', recommendedSize: 'small', recommendedMode: 'panel' },
      { currentSize: 'large', recommendedSize: 'large' },
      { currentSize: null, recommendedSize: 'large' },
      { currentSize: 'medium', recommendedSize: null },
      { currentSize: null, recommendedSize: null },
    ] satisfies Array<Partial<WorkflowSwitchPillProps>>;

    for (const props of unchanged) expect(renderPill('en', props)).toBe('');
    expect(vi.mocked(Button)).not.toHaveBeenCalled();
  });

  test('forwards Switch and Dismiss, and makes no API calls', () => {
    const onSwitch = vi.fn();
    const onDismiss = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    renderPill('en', { onSwitch, onDismiss, recommendedMode: 'overnight' });
    const [switchButton, dismissButton] = vi.mocked(Button).mock.calls.map(([props]) => props);
    const copy = MESSAGES.en.guided.m3.workflowSwitch;

    expect(switchButton.children).toBe(copy.switchToOvernight);
    expect(dismissButton.children).toBe(copy.dismiss);

    switchButton.onClick?.({} as never);
    dismissButton.onClick?.({} as never);
    expect(onSwitch).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('uses the generic switch action without a recommended mode', () => {
    const copy = MESSAGES.en.guided.m3.workflowSwitch;
    const html = renderPill('en');
    const [switchButton] = vi.mocked(Button).mock.calls.map(([props]) => props);

    expect(switchButton.children).toBe(copy.switchAction);
    expect(html).not.toContain('data-recommended-mode');
    expect(visibleText(html)).not.toContain(copy.panel);
    expect(visibleText(html)).not.toContain(copy.overnight);
  });

  test.each([
    ['panel', 'switchToPanel'],
    ['overnight', 'switchToOvernight'],
    ['interactive', 'switchAction'],
  ] as const)('describes a %s recommendation with the matching action', (mode, action) => {
    const copy = MESSAGES.en.guided.m3.workflowSwitch;
    const html = renderPill('en', { recommendedMode: mode });
    const [switchButton] = vi.mocked(Button).mock.calls.map(([props]) => props);

    expect(visibleText(html)).toContain(copy[mode]);
    expect(switchButton.children).toBe(copy[action]);
    expect(html).toContain(`data-recommended-mode="${mode}"`);
  });

  test('disables only Switch and explains why while disabled', () => {
    const copy = MESSAGES.en.guided.m3.workflowSwitch;
    const html = renderPill('en', { disabled: true });
    const [switchButton, dismissButton] = vi.mocked(Button).mock.calls.map(([props]) => props);

    expect(visibleText(html)).toContain(copy.disabled);
    expect(switchButton.disabled).toBe(true);
    const describedBy = switchButton['aria-describedby'];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}"`);
    expect(dismissButton.disabled).toBeUndefined();
  });
});

/*
 * Implementation record: 20261126-m3-r4 (worktree baton/e33e97/m3-r4).
 * Created the presentational WorkflowSwitchPill and its scoped styles: it
 * hides when the sizes match or either size is null, keeps Dismiss available
 * while Switch is disabled, and selects the panel/overnight action copy from
 * recommendedMode. Only the three whitelisted files were created.
 * Verification: the required command could not start because the sandbox
 * could not grant write access to this worktree (SetNamedSecurityInfoW,
 * Win32 5); npm and Vitest never ran. No commit or LOG edit was made.
 */
