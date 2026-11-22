import type { CredentialStatus, PresetItem, RfcReadinessResult } from '../../types/graph';
import { getReadinessState, type ProviderHealth, type ReadinessState } from '../nodes/readiness';

export const WIZARD_STEPS = ['preflight', 'brainstorm', 'launch'] as const;
export type WizardStep = typeof WIZARD_STEPS[number];

export function getWizardStep(step: WizardStep, direction: 'back' | 'next'): WizardStep {
  const index = WIZARD_STEPS.indexOf(step);
  return WIZARD_STEPS[index + (direction === 'back' ? -1 : 1)] ?? step;
}

export type SkipDecision =
  | { kind: 'advance' }
  | { kind: 'confirm'; missingSections: readonly string[] };

export function decideRfcSkip({ missing_sections }: Pick<RfcReadinessResult, 'missing_sections'>): SkipDecision {
  return missing_sections.length > 0
    ? { kind: 'confirm', missingSections: missing_sections }
    : { kind: 'advance' };
}

export function getMaskedCredential(status: CredentialStatus | undefined): string {
  return status?.configured ? status.masked : '';
}

export function findReadyPreset(presets: readonly PresetItem[]): PresetItem | undefined {
  return presets.find((preset) => preset.host_ready === true);
}

export function getPreflightProviderState(
  provider: string,
  preset: Pick<PresetItem, 'host_ready' | 'missing_providers'> | undefined,
  health: ProviderHealth | undefined,
  now: number,
): ReadinessState {
  const state = getReadinessState(health, now);
  // The catalog reflects the latest preflight, while the workspace tracks quota cooldowns.
  if (state === 'cooldown') return state;
  if (preset?.missing_providers) return preset.missing_providers.includes(provider) ? 'missing' : 'ready';
  return preset?.host_ready ? 'ready' : state;
}

export function getInstallCommand(hint: string): string | undefined {
  return hint.match(/`([^`\r\n]+)`/)?.[1].trim() || hint.match(/\b(?:codex login|claude auth login)\b/)?.[0];
}
