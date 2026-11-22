import { describe, expect, test } from 'vitest';
import { codex_only_3tier, presetToItem, starter_2tier } from '../../data/presets';
import type { CredentialStatus, PresetItem, RfcReadinessResult } from '../../types/graph';
import type { ProviderHealth, ReadinessState } from '../nodes/readiness';
import {
  decideRfcSkip,
  findReadyPreset,
  getInstallCommand,
  getMaskedCredential,
  getPreflightProviderState,
  getWizardStep,
  type WizardStep,
} from './launchWizard';

const RFC_WITH_WARNINGS: RfcReadinessResult = {
  score: 65,
  safe_for_overnight: false,
  missing_sections: [],
  warnings: ['Goal is shorter than 40 characters.'],
  detected_commands: [],
};

describe('Wizard navigation', () => {
  test.each([
    ['preflight', 'back', 'preflight'],
    ['preflight', 'next', 'brainstorm'],
    ['brainstorm', 'back', 'preflight'],
    ['brainstorm', 'next', 'launch'],
    ['launch', 'back', 'brainstorm'],
    ['launch', 'next', 'launch'],
  ] as const satisfies readonly (readonly [WizardStep, 'back' | 'next', WizardStep])[])(
    'moves from %s with %s to %s',
    (step, direction, expected) => {
      expect(getWizardStep(step, direction)).toBe(expected);
    },
  );
});

describe('Skip Brainstorm', () => {
  test('advances on the current RFC when all sections exist', () => {
    expect(decideRfcSkip(RFC_WITH_WARNINGS)).toStrictEqual({ kind: 'advance' });
  });

  test('requires confirmation with the exact missing sections returned by readiness', () => {
    const missingSections = ['constraints', 'acceptance'];
    const readiness = { ...RFC_WITH_WARNINGS, missing_sections: missingSections };

    expect(decideRfcSkip(readiness)).toStrictEqual({ kind: 'confirm', missingSections });
  });
});

describe('Credential display', () => {
  const status: CredentialStatus = {
    provider_key: 'OPENAI_API_KEY',
    configured: true,
    source: 'local_file',
    masked: 'sk-p••••abcd',
  };

  test.each([
    [status, 'sk-p••••abcd'],
    [{ ...status, source: 'env', masked: '****' }, '****'],
    [{ ...status, configured: false, source: 'none', masked: '' }, ''],
    [undefined, ''],
  ] as const)('uses the returned mask for status %j', (credential, expected) => {
    expect(getMaskedCredential(credential)).toBe(expected);
  });
});

describe('Preset preflight', () => {
  const missing = { ...presetToItem(starter_2tier), host_ready: false, missing_providers: ['dsh_opencode'] };
  const ready = { ...presetToItem(codex_only_3tier), host_ready: true, missing_providers: [] };
  const provider = 'dsh_opencode';
  const healthy: ProviderHealth = { provider, ok: true, detail: '' };
  const now = 10_000;

  test('picks the first ready preset in catalog order', () => {
    expect(findReadyPreset([missing, ready, { ...missing, host_ready: true }])).toBe(ready);
    expect(findReadyPreset([missing, presetToItem(codex_only_3tier)])).toBeUndefined();
  });

  test.each<[
    Pick<PresetItem, 'host_ready' | 'missing_providers'> | undefined,
    ProviderHealth | undefined,
    ReadinessState,
  ]>([
    [undefined, healthy, 'ready'],
    [undefined, undefined, 'missing'],
    [missing, healthy, 'missing'],
    [{ host_ready: false, missing_providers: ['claude_sub'] }, undefined, 'ready'],
    [{ host_ready: true }, undefined, 'ready'],
    [{ host_ready: true }, { ...healthy, cooldown_until: 11 }, 'cooldown'],
  ])('combines preset %j and provider health %j into %s', (preset, health, expected) => {
    expect(getPreflightProviderState(provider, preset, health, now)).toBe(expected);
  });

  test.each([
    ['Sign in with `claude auth login`. ', 'claude auth login'],
    ['Run codex login.', 'codex login'],
    ['Set OPENCODE_API_KEY in the local credentials store.', undefined],
  ] as const)('copies the command from %j', (hint, expected) => {
    expect(getInstallCommand(hint)).toBe(expected);
  });
});
