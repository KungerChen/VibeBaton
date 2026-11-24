import { describe, expect, test } from 'vitest';
import { BatonApiClient } from '../api/client';
import { presetToItem, starter_2tier } from '../data/presets';
import type { PresetItem } from '../types/graph';
import { filterPresets, getPresetBadges, type RecipeFilter } from './recipePlaza';

const STARTER_SUMMARY = presetToItem(starter_2tier);

function recipe(id: string, metadata: Pick<PresetItem, 'category' | 'host_ready'>): PresetItem {
  return { ...STARTER_SUMMARY, id, ...metadata };
}

const RECIPES = [
  recipe('starter', { category: 'small_project', host_ready: true }),
  recipe('claude_only', { category: 'same_family', host_ready: false }),
  recipe('legacy', {}),
  recipe('batch', { category: 'bulk_batch', host_ready: false }),
  recipe('codex_only', { category: 'same_family', host_ready: true }),
  recipe('audit', { category: 'audit', host_ready: false }),
  recipe('panel', { category: 'panel', host_ready: false }),
  recipe('general', { category: 'general', host_ready: false }),
] as const;

describe('Recipe Plaza filters', () => {
  test.each<readonly [RecipeFilter, readonly string[]]>([
    ['all', ['starter', 'claude_only', 'legacy', 'batch', 'codex_only', 'audit', 'panel', 'general']],
    ['ready_on_host', ['starter', 'codex_only']],
    ['same_family', ['claude_only', 'codex_only']],
    ['bulk_batch', ['batch']],
    ['small_project', ['starter']],
    ['audit', ['audit']],
    ['panel', ['panel']],
  ])('filters %s independently and preserves catalog order', (filter, expected) => {
    expect(filterPresets(RECIPES, filter).map(({ id }) => id)).toEqual(expected);
  });

  test('All displays eight official presets, Panel lists specialist_panel, and Ready on Host is empty in standalone demo', async () => {
    const presets = await new BatonApiClient().listPresets();

    expect(filterPresets(presets, 'all')).toHaveLength(8);
    expect(filterPresets(presets, 'panel').map(({ id }) => id)).toEqual(['specialist_panel']);
    expect(filterPresets(presets, 'ready_on_host')).toEqual([]);
  });
});

describe('Recipe Plaza badges', () => {
  test('maps ready and missing hosts and only lists providers reported missing', () => {
    expect(getPresetBadges({ host_ready: true }).readiness).toEqual({
      label: 'hostReady',
      variant: 'success',
      missingProviders: [],
    });
    expect(getPresetBadges({
      host_ready: false,
      missing_providers: ['codex_sub', 'dsh_opencode'],
    }).readiness).toEqual({
      label: 'hostMissing',
      variant: 'warning',
      missingProviders: ['codex_sub', 'dsh_opencode'],
    });
    expect(getPresetBadges({ host_ready: false }).readiness?.missingProviders).toEqual([]);
  });

  test('maps each cost tier to its badge and handles summaries without catalog metadata', () => {
    expect(getPresetBadges({ cost_tier: 'low' }).cost).toEqual({ tier: 'low', variant: 'secondary' });
    expect(getPresetBadges({ cost_tier: 'medium' }).cost).toEqual({ tier: 'medium', variant: 'info' });
    expect(getPresetBadges({ cost_tier: 'high' }).cost).toEqual({ tier: 'high', variant: 'violet' });
    expect(getPresetBadges({})).toEqual({ readiness: null, cost: null });
  });
});
