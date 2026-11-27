import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { MESSAGES } from '../../i18n/messages';
import { Button } from '../ui/button';
import { GuidedFailedBanner, type GuidedFailedBannerProps } from './GuidedFailedBanner';

vi.mock('../ui/button', () => ({
  Button: vi.fn(({ children, variant: _variant, ...props }: ComponentProps<typeof Button>) =>
    createElement('button', props, children)),
}));

function renderBanner(locale: 'en' | 'zh', props: GuidedFailedBannerProps = {}): string {
  vi.stubGlobal('window', { localStorage: { getItem: () => locale } });
  return renderToStaticMarkup(createElement(I18nProvider, { children: createElement(GuidedFailedBanner, props) }));
}

afterEach(() => {
  vi.mocked(Button).mockClear();
  vi.unstubAllGlobals();
});

describe('GuidedFailedBanner', () => {
  test.each(['en', 'zh'] as const)('renders localized accessible failure details in %s', (locale) => {
    const copy = MESSAGES[locale].guided.m3.failed;
    const html = renderBanner(locale, { detail: 'Check <failed>' });
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/aria-labelledby="[^"]+"/);
    expect(html).toContain(copy.title);
    expect(html).toContain(copy.description);
    expect(html).toContain(copy.details);
    expect(html).toContain('Check &lt;failed&gt;');
    expect(html).not.toContain(copy.replan);
  });

  test('renders the parent-provided action, forwards clicks, and makes no API calls', () => {
    const onStopAndReplan = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const html = renderBanner('en', { onStopAndReplan });
    expect(html).toContain(MESSAGES.en.guided.m3.failed.noDetails);
    expect(html).toContain(MESSAGES.en.guided.m3.failed.replan.replaceAll('&', '&amp;'));
    const props = vi.mocked(Button).mock.calls[0][0];
    expect(props.disabled).toBe(false);
    props.onClick?.({} as never);
    expect(onStopAndReplan).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('shows progress and disables the action while stopping', () => {
    const html = renderBanner('zh', { busy: true, onStopAndReplan: () => {} });
    expect(html).toContain(MESSAGES.zh.guided.m3.failed.stopping);
    expect(html).toContain('disabled=""');
  });
});
