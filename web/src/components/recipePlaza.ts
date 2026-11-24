import type { CostTier, PresetCategory, PresetItem } from '../types/graph';
import type { BadgeProps } from './ui/badge';

export type RecipeFilter = 'all' | 'ready_on_host' | Exclude<PresetCategory, 'general'>;

export const RECIPE_FILTERS = [
  'all', 'ready_on_host', 'same_family', 'bulk_batch', 'small_project', 'audit', 'panel',
] as const satisfies readonly RecipeFilter[];

export function filterPresets(presets: readonly PresetItem[], filter: RecipeFilter): readonly PresetItem[] {
  if (filter === 'all') return presets;
  if (filter === 'ready_on_host') return presets.filter(({ host_ready }) => host_ready === true);
  return presets.filter(({ category }) => category === filter);
}

const COST_BADGE_VARIANTS = {
  low: 'secondary',
  medium: 'info',
  high: 'violet',
} as const satisfies Record<CostTier, NonNullable<BadgeProps['variant']>>;

export function getPresetBadges({
  host_ready,
  missing_providers,
  cost_tier,
}: Pick<PresetItem, 'host_ready' | 'missing_providers' | 'cost_tier'>) {
  const readiness = host_ready === undefined
    ? null
    : host_ready
      ? { label: 'hostReady', variant: 'success', missingProviders: [] } as const
      : { label: 'hostMissing', variant: 'warning', missingProviders: missing_providers ?? [] } as const;

  return {
    readiness,
    cost: cost_tier === undefined ? null : { tier: cost_tier, variant: COST_BADGE_VARIANTS[cost_tier] },
  };
}
