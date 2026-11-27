import type { RfcReadinessResult } from '../../types/graph';

export type SkipDecision =
  | { kind: 'advance' }
  | { kind: 'confirm'; missingSections: readonly string[] };

export function decideRfcSkip({ missing_sections }: Pick<RfcReadinessResult, 'missing_sections'>): SkipDecision {
  return missing_sections.length > 0
    ? { kind: 'confirm', missingSections: missing_sections }
    : { kind: 'advance' };
}
