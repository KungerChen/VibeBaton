import { MESSAGES, type Locale } from '../i18n/messages';
import type { DoctorRoleResult, ModelCapability, RoleConfig, RolesConfigResponse } from '../types/graph';
import { flagship_4tier } from './presets/flagship_4tier';

const installHints = new Map([
  ['claude_sub', 'Install the Claude CLI and run `claude auth login`.'],
  ['codex_sub', 'Install the Codex CLI and run `codex login`.'],
  ['dsh_deepseek', 'Install the DeepSeek Harness CLI and set DEEPSEEK_API_KEY.'],
]);

export function demoProviderHealth(provider: string, locale: Locale = 'en'): Omit<DoctorRoleResult, 'latency_ms'> {
  if (provider === 'host_native') {
    return { provider, ok: true, detail: 'Ready in standalone demo.', install_hint: '' };
  }
  if (!provider) {
    return { provider, ok: false, detail: 'Select a configured provider or role.', install_hint: '' };
  }
  const install_hint = provider === 'dsh_opencode'
    ? MESSAGES[locale].nodeReadiness.dshInstallHint
    : (installHints.get(provider) ?? 'Check the provider CLI installation and PATH.');
  return {
    provider,
    ok: false,
    detail: 'Missing in standalone demo.',
    install_hint,
  };
}

const roles = Object.fromEntries(flagship_4tier.nodes.flatMap<[string, RoleConfig]>(({ role, config }) => {
  const { provider, model } = config ?? {};
  if (!role || typeof provider !== 'string' || typeof model !== 'string') return [];
  return [[role, { provider, model, fallback: [] }]];
}));

const costTiers: Record<string, ModelCapability['cost_tier']> = {
  tactical_planner: 'flagship',
  milestone_reviewer: 'flagship',
  micro_orchestrator: 'flagship',
  bulk_worker: 'eco',
};

export const DEMO_ROLES_CONFIG: Omit<RolesConfigResponse, 'budget_profile'> = {
  config_path: '',
  providers: {
    host_native: { max_concurrency: 1, command: [] },
    claude_sub: { max_concurrency: 1, command: ['claude'] },
    codex_sub: { max_concurrency: 1, command: ['codex'] },
    dsh_opencode: { max_concurrency: 4, command: ['dsh'] },
    dsh_deepseek: { max_concurrency: 4, command: ['dsh'] },
  },
  roles,
  model_catalog: Object.entries(roles).map(([role, { provider, model }]) => {
    const { ok, detail } = demoProviderHealth(provider);
    const efforts = ok ? [] : ['low', 'high', 'max'];
    const effort = model.split('@')[1];
    if (effort && !efforts.includes(effort)) efforts.push(effort);
    return { provider, model, detail, efforts, ready: ok, cost_tier: costTiers[role] ?? 'standard' };
  }),
};
