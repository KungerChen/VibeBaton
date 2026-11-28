import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { MESSAGES, type Locale } from '../i18n/messages';
import type { StudioMode } from '../lib/studioMode';
import { HeaderBar } from './HeaderBar';
import { Button } from './ui/button';

vi.mock('./ui/button', () => ({
  Button: vi.fn(({ children, variant: _variant, size: _size, ...props }: ComponentProps<typeof Button>) =>
    createElement('button', props, children)),
}));

function render(locale: Locale, studioMode?: StudioMode, onStudioModeChange = vi.fn()) {
  vi.stubGlobal('window', { localStorage: { getItem: () => locale } });
  const html = renderToStaticMarkup(createElement(I18nProvider, {
    children: createElement(HeaderBar, { mode: 'local', graphName: 'Starter', studioMode, onStudioModeChange }),
  }));
  return { html, onStudioModeChange };
}

function buttonProps(label: string) {
  return vi.mocked(Button).mock.calls.map(([props]) => props).find((props) => props.children === label);
}

afterEach(() => {
  vi.mocked(Button).mockClear();
  vi.unstubAllGlobals();
});

describe('HeaderBar mode entry', () => {
  test('the workbench shows one quiet entry into Pro mode instead of a Guided | Pro switch', () => {
    const { html, onStudioModeChange } = render('en', 'guided');
    const entry = buttonProps(MESSAGES.en.header.toProMode);
    expect(MESSAGES.en.header.toProMode).toBe('Switch to Pro mode');
    expect(entry?.variant).toBe('ghost');
    expect(html).not.toContain('aria-pressed="true">Guided');
    expect(html).not.toContain(MESSAGES.en.header.toGuidedMode);
    entry?.onClick?.({} as never);
    expect(onStudioModeChange).toHaveBeenCalledExactlyOnceWith('pro');
  });

  test('Pro mode offers the way back to the workbench, in both languages', () => {
    for (const locale of ['en', 'zh'] as const) {
      vi.mocked(Button).mockClear();
      const { html, onStudioModeChange } = render(locale, 'pro');
      expect(html).toContain(MESSAGES[locale].header.toGuidedMode);
      expect(html).not.toContain(MESSAGES[locale].header.toProMode);
      buttonProps(MESSAGES[locale].header.toGuidedMode)?.onClick?.({} as never);
      expect(onStudioModeChange).toHaveBeenCalledExactlyOnceWith('guided');
    }
    expect(MESSAGES.zh.header.toGuidedMode).toBe('回到引导模式');
    expect(MESSAGES.zh.header.toProMode).toBe('切换到专业模式');
  });

  test('without a studio mode there is no mode entry', () => {
    const { html } = render('en');
    expect(html).not.toContain(MESSAGES.en.header.toProMode);
    expect(html).not.toContain(MESSAGES.en.header.toGuidedMode);
  });
});
