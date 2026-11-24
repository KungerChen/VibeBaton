import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { presetToItem, starter_2tier } from '../data/presets';
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
