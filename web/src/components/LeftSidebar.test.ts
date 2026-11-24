import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { presetToItem, starter_2tier } from '../data/presets';
import { I18nProvider } from '../i18n';
import { MESSAGES, type Locale } from '../i18n/messages';
import { LeftSidebar } from './LeftSidebar';

describe('LeftSidebar provider display masking', () => {
  test('masks dsh_opencode as DSH in missing-provider tooltips and aria-description', () => {
    const preset = {
      ...presetToItem(starter_2tier),
      category: 'general' as const,
      required_providers: ['dsh_opencode'],
      cost_tier: 'low' as const,
      inspired_by: null,
      host_ready: false,
      missing_providers: ['dsh_opencode'],
    };

    const markup = renderToStaticMarkup(createElement(LeftSidebar, {
      presets: [preset],
      budgetProfile: 'balanced',
      budgetProfileSaving: false,
      onBudgetProfileChange: vi.fn(),
      currentGraphId: starter_2tier.id,
      onSelectPreset: vi.fn(),
      onAddNode: vi.fn(),
      onOpenTransfer: vi.fn(),
      caseExportAvailable: false,
      validation: null,
    }));

    expect(markup).toContain('aria-description="DSH"');
    expect(markup).toContain('title="DSH"');
    expect(markup).not.toMatch(/opencode/i);
  });
});

describe('LeftSidebar recipe plaza filters', () => {
  test.each<readonly [Locale, string]>([
    ['en', 'Panel & Execute'],
    ['zh', '会诊协作'],
  ])('renders the panel pill from the %s message catalog', (locale, label) => {
    vi.stubGlobal('window', { localStorage: { getItem: () => locale } });
    try {
      const markup = renderToStaticMarkup(createElement(I18nProvider, {
        children: createElement(LeftSidebar, {
          presets: [],
          budgetProfile: 'balanced',
          budgetProfileSaving: false,
          onBudgetProfileChange: vi.fn(),
          currentGraphId: starter_2tier.id,
          onSelectPreset: vi.fn(),
          onAddNode: vi.fn(),
          onOpenTransfer: vi.fn(),
          caseExportAvailable: false,
          validation: null,
        }),
      }));

      expect(MESSAGES[locale].recipePlaza.filters.panel).toBe(label);
      expect(markup).toMatch(new RegExp(
        `<button[^>]*aria-pressed="false"[^>]*>${label.replaceAll('&', '&amp;')}</button>`,
      ));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
