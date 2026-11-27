import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CliScanEntry, CliScanResult, CliScanStatus } from '../../api/client';
import { I18nProvider } from '../../i18n';
import { MESSAGES } from '../../i18n/messages';
import { Button } from '../ui/button';
import { CliSummaryBar, type CliSummaryBarProps } from './CliSummaryBar';

vi.mock('../ui/button', () => ({
  Button: vi.fn(({ children, variant: _variant, size: _size, ...props }: ComponentProps<typeof Button>) =>
    createElement('button', props, children)),
}));

function scanEntry(status: CliScanStatus, index: number): CliScanEntry {
  return {
    id: `cli-${index}`,
    status,
    binary_path: null,
    version: null,
    prereq_missing: [],
    reason_en: '',
    reason_zh: '',
  };
}

function scanWith(statuses: readonly CliScanStatus[]): CliScanResult {
  return {
    drivers: statuses.map((status, index) => scanEntry(status, index)),
    http_api_keys_present: [],
    scanned_at: 0,
  };
}

function renderBar(locale: 'en' | 'zh', props: Partial<CliSummaryBarProps> = {}): string {
  vi.stubGlobal('window', { localStorage: { getItem: () => locale } });
  return renderToStaticMarkup(createElement(I18nProvider, {
    children: createElement(CliSummaryBar, {
      scan: props.scan ?? null,
      scanning: props.scanning ?? false,
      onScan: props.onScan ?? (() => {}),
      onOpenDetails: props.onOpenDetails ?? (() => {}),
    }),
  }));
}

function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

afterEach(() => {
  vi.mocked(Button).mockClear();
  vi.unstubAllGlobals();
});

describe('CliSummaryBar', () => {
  test.each(['en', 'zh'] as const)('renders localized counts and actions in %s', (locale) => {
    const copy = MESSAGES[locale].guided.m3.cliSummary;
    const html = renderBar(locale, {
      scan: scanWith(['ready', 'installed_unauthenticated', 'installed_unauthenticated', 'missing', 'prereq_missing']),
    });
    const text = visibleText(html);
    expect(html).toMatch(/aria-labelledby="[^"]+"/);
    expect(text).toContain(copy.title);
    expect(text).toContain(`${copy.ready} 1`);
    expect(text).toContain(`${copy.needsSignIn} 2`);
    expect(text).toContain(`${copy.missing} 1`);
    expect(text).toContain(`${copy.prerequisite} 1`);
    expect(text).toContain(copy.rescan);
    expect(text).toContain(copy.details);
  });

  test('renders zero ready CLIs alongside the other statuses', () => {
    const html = renderBar('en', { scan: scanWith(['missing', 'installed_unauthenticated']) });
    const copy = MESSAGES.en.guided.m3.cliSummary;
    expect(html).toContain('data-status="ready" data-count="0"');
    expect(visibleText(html)).toContain(`${copy.ready} 0`);
  });

  test('renders one ready CLI', () => {
    const html = renderBar('en', { scan: scanWith(['ready', 'missing']) });
    const copy = MESSAGES.en.guided.m3.cliSummary;
    expect(html).toContain('data-status="ready" data-count="1"');
    expect(visibleText(html)).toContain(`${copy.ready} 1`);
  });

  test('renders many ready CLIs', () => {
    const html = renderBar('zh', { scan: scanWith(['ready', 'ready', 'ready', 'ready']) });
    const copy = MESSAGES.zh.guided.m3.cliSummary;
    expect(html).toContain('data-status="ready" data-count="4"');
    expect(visibleText(html)).toContain(`${copy.ready} 4`);
  });

  test('shows the localized empty note before any scan', () => {
    const copy = MESSAGES.en.guided.m3.cliSummary;
    const html = renderBar('en');
    const text = visibleText(html);
    expect(text).toContain(copy.empty);
    expect(text).toContain(copy.scan);
    expect(html).not.toContain(copy.rescan);
    expect(html).not.toContain('data-status=');
  });

  test('shows the empty note and zero counts when a scan finds no tools', () => {
    const copy = MESSAGES.en.guided.m3.cliSummary;
    const html = renderBar('en', { scan: scanWith([]) });
    expect(visibleText(html)).toContain(copy.empty);
    expect(html).toContain('data-status="ready" data-count="0"');
  });

  test('shows progress and disables the scan action while scanning', () => {
    const copy = MESSAGES.zh.guided.m3.cliSummary;
    const html = renderBar('zh', { scan: scanWith(['ready']), scanning: true });
    const props = vi.mocked(Button).mock.calls[0][0];
    expect(props.disabled).toBe(true);
    expect(visibleText(html)).toContain(copy.scanning);
  });

  test('forwards the parent callbacks and makes no API calls', () => {
    const onScan = vi.fn();
    const onOpenDetails = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    renderBar('en', { scan: scanWith(['ready']), onScan, onOpenDetails });
    const [scanButton, detailsButton] = vi.mocked(Button).mock.calls.map(([props]) => props);
    scanButton.onClick?.({} as never);
    detailsButton.onClick?.({} as never);
    expect(onScan).toHaveBeenCalledOnce();
    expect(onOpenDetails).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
});
