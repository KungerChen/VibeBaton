import './GuidedSetupStep.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BatonApiClient,
  type ApiMode,
  type CliDriver,
  type CliLoginResult,
  type CliScanEntry,
  type CliScanResult,
  type ModelCatalogEntry,
  type ModelCatalogResponse,
  type RecommendedLineup,
  type SavedLineupProfile,
  type TierRecommendation,
  type WorkspaceInfo,
} from '../../api/client';
import { MESSAGES, type Locale } from '../../i18n/messages';
import { formatProviderDisplay, formatProviderIdsInText, translateRole } from '../../i18n/presets';
import type { CredentialStatus } from '../../types/graph';
import { localizeGuidedError } from './guidedErrors';
import { CliSummaryBar } from './CliSummaryBar';
import { InstallConfirmPopover } from './InstallConfirmPopover';
import { useGuidedSession, type GuidedSessionApi, type GuidedSessionState } from './useGuidedSession';

/** The client methods this step needs; inject a fake in tests. */
export type GuidedSetupApi = Pick<
  BatonApiClient,
  'getWorkspaceInfo' | 'selectWorkspace' | 'initGitWorkspace' | 'getCliRegistry' | 'scanCliRegistry' | 'installCli' | 'loginCli'
> & Partial<Pick<
  BatonApiClient,
  'browseWorkspace' | 'getRoles' | 'listCredentials' | 'saveCredentials' | 'getModelCatalog' | 'syncModelCatalog'
  | 'getLineupProfiles' | 'saveLineupProfile' | 'deleteLineupProfile' | 'saveLastUsedLineup'
  | 'getGuidedSession' | 'saveGuidedSession' | 'resetGuidedSession'
>>;

let defaultApi: GuidedSetupApi | null = null;
function getDefaultApi(): GuidedSetupApi {
  return (defaultApi ??= new BatonApiClient());
}

const DSH_TEXT_RE = /\bdsh_(?:opencode|deepseek)\b/gi;

export type DriverFilter = 'all' | 'ready' | 'needs_setup';

/** Registry `name` for display; the dsh driver is always shown as `DSH`, never its backend wiring. */
export function driverDisplayName(driver: Pick<CliDriver, 'id' | 'name'>): string {
  if (driver.id === 'dsh') return 'DSH';
  return driver.name.trim() || driver.id;
}

/** Free text shown in a driver row; for dsh, any text mentioning its OpenCode backend is dropped. */
function driverText(driver: Pick<CliDriver, 'id'>, text: string): string {
  const scrubbed = text.replace(DSH_TEXT_RE, 'DSH');
  return driver.id === 'dsh' && /opencode/i.test(scrubbed) ? '' : scrubbed;
}

/** Filter registry drivers by scan status for quick triage in Guided Setup. */
export function filterDrivers(
  drivers: readonly CliDriver[],
  entries: Record<string, CliScanEntry>,
  filter: DriverFilter,
): CliDriver[] {
  if (filter === 'all') return [...drivers];
  if (filter === 'ready') return drivers.filter((driver) => entries[driver.id]?.status === 'ready');
  return drivers.filter((driver) => entries[driver.id]?.status !== 'ready');
}

const API_KEY_ORDER = [
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENCODE_API_KEY',
] as const;

/** Ready CLI drivers whose providers are all HTTP-backed and missing their required API key. */
export function driversNeedingApiKey(
  drivers: readonly CliDriver[],
  entries: Record<string, CliScanEntry>,
  httpApiKeysPresent: readonly string[],
): { driver: CliDriver; envKey: string }[] {
  const keys = new Set(httpApiKeysPresent);
  const missing: { driver: CliDriver; envKey: string }[] = [];
  for (const driver of drivers) {
    if (entries[driver.id]?.status !== 'ready') continue;
    if (driver.provider_ids.length === 0 || !driver.provider_ids.every((pid) => pid.endsWith('_http'))) continue;
    if (driver.env_keys.length === 0 || driver.env_keys.some((key) => keys.has(key))) continue;
    missing.push({ driver, envKey: driver.env_keys[0] });
  }
  return missing;
}

/** Collect selectable ready/configured provider IDs for team role customization. */
export function availableLineupProviders(
  lineup: RecommendedLineup | null,
  drivers: readonly CliDriver[],
  entries: Record<string, CliScanEntry>,
  configuredProviders?: readonly string[],
  httpApiKeysPresent: readonly string[] = [],
): string[] {
  const activeRoleProviders = new Set(Object.values(lineup?.roles ?? {}));
  const result = new Set<string>(activeRoleProviders);
  const configured = configuredProviders ? new Set(configuredProviders) : null;
  const httpKeys = new Set(httpApiKeysPresent);

  for (const driver of drivers) {
    if (entries[driver.id]?.status !== 'ready') continue;
    const hasHttpKey = driver.env_keys.some((key) => httpKeys.has(key));
    for (const pid of driver.provider_ids) {
      if (configured && !configured.has(pid)) continue;
      if (pid.endsWith('_http') && !activeRoleProviders.has(pid) && !hasHttpKey) continue;
      if (pid === 'dsh_opencode' && driver.id !== 'dsh') continue;
      result.add(pid);
    }
  }
  return [...result];
}

export const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultra: 'Ultra',
};

const ALL_EFFORT_IDS = ['low', 'medium', 'high', 'xhigh', 'max'];

function builtinEntry(
  id: string,
  label: string,
  family: string,
  providers: string[],
  status: ModelCatalogEntry['status'],
  cost_tier: ModelCatalogEntry['cost_tier'],
  rank: number,
  default_effort: string,
  efforts: string[] = ALL_EFFORT_IDS,
  provider_efforts?: Record<string, string[]>,
): ModelCatalogEntry {
  return provider_efforts
    ? { id, label, family, providers, status, cost_tier, rank, efforts, default_effort, provider_efforts }
    : { id, label, family, providers, status, cost_tier, rank, efforts, default_effort };
}

/** Offline fallback only: the recommended models. The full, daily-synced list comes from GET /api/models/catalog. */
export const BUILTIN_MODEL_CATALOG: Pick<ModelCatalogResponse, 'models' | 'tier_recommendations' | 'role_tiers' | 'efforts'> = {
  efforts: [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'XHigh' },
    { id: 'max', label: 'Max' },
  ],
  role_tiers: {
    brainstorm_and_final_gate: 'L0',
    tactical_planner: 'L1',
    milestone_reviewer: 'L1',
    critical_executor: 'L2',
    micro_orchestrator: 'L2',
    bulk_worker: 'L3',
  },
  tier_recommendations: {
    L0: [
      { providers: ['agy_sub', 'gemini_sub', 'gemini_http'], model: 'gemini-4-carbon', effort: 'medium', note_en: '', note_zh: '' },
      { providers: ['claude_sub'], model: 'claude-fable-5-2', effort: 'medium', note_en: '', note_zh: '' },
      { providers: ['codex_sub', 'openai_http'], model: 'gpt-6.2-astra', effort: 'xhigh', note_en: '', note_zh: '' },
    ],
    L1: [
      { providers: ['claude_sub'], model: 'claude-opus-5-5', effort: 'medium', note_en: '', note_zh: '' },
      { providers: ['agy_sub', 'gemini_sub', 'gemini_http'], model: 'gemini-4-neon', effort: 'medium', note_en: '', note_zh: '' },
      { providers: ['codex_sub', 'openai_http'], model: 'gpt-6.2-sol', effort: 'max', note_en: '', note_zh: '' },
    ],
    L2: [
      { providers: ['codex_sub', 'openai_http'], model: 'gpt-6.2-sol', effort: 'max', note_en: '', note_zh: '' },
      { providers: ['claude_sub'], model: 'claude-sonnet-5-5', effort: 'max', note_en: '', note_zh: '' },
      { providers: ['agy_sub', 'gemini_sub', 'gemini_http'], model: 'gemini-4-hydrogen', effort: 'max', note_en: '', note_zh: '' },
    ],
    L3: [
      { providers: ['dsh_opencode', 'dsh_deepseek'], model: 'deepseek-v4.1-flash', effort: 'max', note_en: '', note_zh: '' },
      { providers: ['claude_sub'], model: 'claude-haiku-5-5', effort: 'max', note_en: '', note_zh: '' },
      { providers: ['codex_sub', 'openai_http'], model: 'gpt-6.1-terra', effort: 'max', note_en: '', note_zh: '' },
      { providers: ['codex_sub', 'openai_http'], model: 'gpt-6-luna', effort: 'max', note_en: '', note_zh: '' },
    ],
  },
  models: [
    builtinEntry('gemini-4-carbon', 'Gemini 4 Carbon', 'gemini', ['agy_sub', 'gemini_sub', 'gemini_http'], 'latest', 'flagship', 1, 'medium'),
    builtinEntry('gemini-4-neon', 'Gemini 4 Neon', 'gemini', ['agy_sub', 'gemini_sub', 'gemini_http'], 'latest', 'standard', 2, 'medium'),
    builtinEntry('gemini-4-hydrogen', 'Gemini 4 Hydrogen', 'gemini', ['agy_sub', 'gemini_sub', 'gemini_http'], 'latest', 'eco', 3, 'max'),
    builtinEntry('claude-fable-5-2', 'Claude Fable 5.2', 'claude', ['claude_sub'], 'latest', 'flagship', 1, 'medium'),
    builtinEntry('claude-opus-5-5', 'Claude Opus 5.5', 'claude', ['claude_sub', 'agy_sub'], 'latest', 'flagship', 2, 'medium'),
    builtinEntry('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'claude', ['claude_sub', 'agy_sub'], 'latest', 'standard', 3, 'max'),
    builtinEntry('claude-haiku-5-5', 'Claude Haiku 5.5', 'claude', ['claude_sub', 'agy_sub'], 'latest', 'eco', 4, 'max'),
    builtinEntry('gpt-6.2-astra', 'GPT-6.2 Astra', 'openai', ['codex_sub', 'openai_http'], 'latest', 'flagship', 1, 'xhigh'),
    builtinEntry('gpt-6.2-sol', 'GPT-6.2 Sol', 'openai', ['codex_sub', 'openai_http'], 'latest', 'standard', 2, 'max'),
    builtinEntry('gpt-6.1-terra', 'GPT-6.1 Terra', 'openai', ['codex_sub', 'openai_http'], 'latest', 'eco', 3, 'max'),
    builtinEntry('gpt-6-luna', 'GPT-6 Luna', 'openai', ['codex_sub', 'openai_http'], 'latest', 'eco', 4, 'max'),
    builtinEntry(
      'deepseek-v4.1-flash',
      'DeepSeek V4.1 Flash',
      'deepseek',
      ['dsh_opencode'],
      'latest',
      'eco',
      1,
      'max',
      ['low', 'high', 'max'],
      { dsh_opencode: ['low', 'high', 'max'] },
    ),
  ],
};

/** Parse a `provider:model@effort` spec cleanly with fallback defaults. */
export function parseRoleSpec(spec: string, fallbackProvider: string): { provider: string; model: string; effort: string } {
  const trimmed = spec.trim();
  const colonIdx = trimmed.indexOf(':');
  const provider = colonIdx > 0 ? trimmed.slice(0, colonIdx) : fallbackProvider;
  const rest = colonIdx > 0 ? trimmed.slice(colonIdx + 1) : trimmed;
  const atIdx = rest.indexOf('@');
  if (atIdx >= 0) {
    return { provider, model: rest.slice(0, atIdx), effort: rest.slice(atIdx + 1) || 'high' };
  }
  return { provider, model: rest, effort: '' };
}

/** Serialize `{provider, model, effort}` back into a VibeBaton `model_overrides` string. */
export function formatRoleSpec(provider: string, model: string, effort: string): string {
  if (!model) return provider;
  return effort ? `${provider}:${model}@${effort}` : `${provider}:${model}`;
}

/** Bundled presets that read the whole `model@effort` spec from the VIBEBATON_MODEL environment variable. */
const ENV_MODEL_PRESETS = ['dsh-headless-opencode-go.patch.yml'];

/**
 * Which role pickers take effect for a provider, judged from its loaded command template.
 * HTTP providers (empty command) send model and reasoning effort in the request; unknown providers keep both.
 * A template loading an env-driven preset (DSH's patch file) gets the spec via VIBEBATON_MODEL instead.
 */
export function providerTemplateSupport(command: readonly string[] | undefined): { model: boolean; effort: boolean } {
  if (!command || command.length === 0) return { model: true, effort: true };
  const uses = (placeholder: string) => command.some((token) => token.includes(placeholder));
  if (ENV_MODEL_PRESETS.some(uses)) return { model: true, effort: true };
  return { model: uses('{model_name}') || uses('{model}'), effort: uses('{effort}') || uses('{model}') };
}

/** Efforts a model offers on a provider: the CLI's own list when it reported one, else the catalog default. */
export function effortOptionsFor(
  entry: Pick<ModelCatalogEntry, 'provider_efforts'> | undefined,
  providerId: string,
  efforts: readonly { id: string; label: string }[],
): { id: string; label: string }[] {
  const reported = entry?.provider_efforts?.[providerId];
  if (!reported || reported.length === 0) return [...efforts];
  return reported.map((id) => ({ id, label: efforts.find((e) => e.id === id)?.label ?? EFFORT_LABELS[id] ?? id }));
}

/** Keep `effort` when offered, else `fallback` when offered, else the strongest offered effort. */
export function coerceEffort(effort: string, options: readonly { id: string }[], fallback: string): string {
  const ids = options.map((option) => option.id);
  if (ids.includes(effort)) return effort;
  if (ids.includes(fallback)) return fallback;
  return ids.at(-1) ?? effort;
}

/** Wait for the server's start-up sync (20s fetch timeout) before re-reading a stale catalog. */
export const STALE_CATALOG_REFETCH_MS = 30_000;

/** Re-read a stale catalog once after a delay; returns a cancel function, or null when nothing is scheduled. */
export function scheduleStaleCatalogRefetch(
  catalog: Pick<ModelCatalogResponse, 'cache'> | null,
  refetch: () => void,
  delayMs: number = STALE_CATALOG_REFETCH_MS,
): (() => void) | null {
  if (!catalog?.cache?.stale) return null;
  const timer = setTimeout(refetch, delayMs);
  return () => clearTimeout(timer);
}

/** List all active + legacy models supported by `providerId` in ranked order. */
export function modelsForProvider(models: readonly ModelCatalogEntry[], providerId: string): ModelCatalogEntry[] {
  return models
    .filter((entry) => entry.providers.includes(providerId))
    .sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id));
}

/** Recommend `{provider, model, effort}` for `role` filtered to `selectableProviders`. */
export function recommendRoleSpec(
  role: string,
  selectableProviders: readonly string[],
  catalog: Pick<ModelCatalogResponse, 'models' | 'tier_recommendations' | 'role_tiers'> = BUILTIN_MODEL_CATALOG,
  preferredProvider?: string,
): { provider: string; model: string; effort: string } {
  const tier = catalog.role_tiers[role] ?? 'L2';
  const recs: readonly TierRecommendation[] = catalog.tier_recommendations[tier] ?? [];

  if (preferredProvider) {
    const choices = modelsForProvider(catalog.models, preferredProvider);
    const rec = recs.find((item) => item.providers.includes(preferredProvider));
    // Mirrors the backend's recommend_role_assignment: a recommended model the provider does not offer
    // falls back to the provider's best model of the same cost tier.
    if (rec && choices.some((m) => m.id === rec.model)) return { provider: preferredProvider, model: rec.model, effort: rec.effort };
    if (choices.length > 0) {
      const targetTier = tier === 'L0' ? 'flagship' : tier === 'L3' ? 'eco' : 'standard';
      const chosen = choices.find((m) => m.cost_tier === targetTier) ?? choices[0];
      return {
        provider: preferredProvider,
        model: chosen.id,
        effort: tier === 'L0' || tier === 'L1' ? 'medium' : 'max',
      };
    }
    return { provider: preferredProvider, model: '', effort: tier === 'L0' || tier === 'L1' ? 'medium' : 'max' };
  }

  const readySet = new Set(selectableProviders);
  for (const rec of recs) {
    const matched = rec.providers.find((pid) => readySet.has(pid));
    if (matched) return recommendRoleSpec(role, selectableProviders, catalog, matched);
  }

  const fallback = selectableProviders[0] ?? '';
  return fallback ? recommendRoleSpec(role, selectableProviders, catalog, fallback) : { provider: '', model: '', effort: 'medium' };
}

/** Build the tiered default lineup (with L0..L3 market-rank model@effort specs) for a ready team. */
export function buildTieredLineup(
  base: RecommendedLineup,
  selectableProviders: readonly string[],
  catalog: Pick<ModelCatalogResponse, 'models' | 'tier_recommendations' | 'role_tiers'> = BUILTIN_MODEL_CATALOG,
): RecommendedLineup {
  if (!base.ready || Object.keys(base.roles).length === 0) return base;
  const effectiveProviders = selectableProviders.length > 0 ? selectableProviders : [...new Set(Object.values(base.roles))];
  const roles: Record<string, string> = {};
  const model_overrides: Record<string, string> = {};
  for (const role of Object.keys(base.roles)) {
    const rec = recommendRoleSpec(role, effectiveProviders, catalog);
    const chosenProvider = rec.provider || base.roles[role];
    roles[role] = chosenProvider;
    if (rec.model) {
      model_overrides[role] = formatRoleSpec(chosenProvider, rec.model, rec.effort);
    }
  }
  return { ...base, roles, model_overrides };
}

/** Build a new lineup assigning every role to `providerId` with each role's tier-appropriate model & effort. */
export function assignAllRoles(
  lineup: RecommendedLineup,
  providerId: string,
  catalog: Pick<ModelCatalogResponse, 'models' | 'tier_recommendations' | 'role_tiers'> = BUILTIN_MODEL_CATALOG,
): RecommendedLineup {
  const roles: Record<string, string> = {};
  const model_overrides: Record<string, string> = {};
  for (const role of Object.keys(lineup.roles)) {
    roles[role] = providerId;
    const rec = recommendRoleSpec(role, [providerId], catalog, providerId);
    if (rec.model) {
      model_overrides[role] = formatRoleSpec(providerId, rec.model, rec.effort);
    }
  }
  return { ...lineup, roles, model_overrides };
}

/** Build a new lineup overriding one role's provider (plus auto-picking its best tier model under that provider). */
export function assignRoleProvider(
  lineup: RecommendedLineup,
  role: string,
  providerId: string,
  catalog: Pick<ModelCatalogResponse, 'models' | 'tier_recommendations' | 'role_tiers'> = BUILTIN_MODEL_CATALOG,
): RecommendedLineup {
  const rec = recommendRoleSpec(role, [providerId], catalog, providerId);
  const model_overrides = { ...(lineup.model_overrides ?? {}) };
  if (rec.model) {
    model_overrides[role] = formatRoleSpec(providerId, rec.model, rec.effort);
  } else {
    delete model_overrides[role];
  }
  return { ...lineup, roles: { ...lineup.roles, [role]: providerId }, model_overrides };
}

/** Build a new lineup updating one role's explicit model or thinking effort without changing provider. */
export function assignRoleModelSpec(
  lineup: RecommendedLineup,
  role: string,
  providerId: string,
  model: string,
  effort: string,
): RecommendedLineup {
  const model_overrides = { ...(lineup.model_overrides ?? {}) };
  if (model) {
    model_overrides[role] = formatRoleSpec(providerId, model, effort);
  } else {
    delete model_overrides[role];
  }
  return { ...lineup, roles: { ...lineup.roles, [role]: providerId }, model_overrides };
}

/** True when any role provider or model@effort differs from the baseline lineup. */
export function isLineupCustomized(
  base: RecommendedLineup | null,
  current: RecommendedLineup | null,
): boolean {
  if (!base || !current) return false;
  return Object.keys(base.roles).some((role) => (
    base.roles[role] !== current.roles[role]
    || (base.model_overrides?.[role] ?? '') !== (current.model_overrides?.[role] ?? '')
  ));
}

/** Apply a saved or last-used lineup onto `baseline`, gracefully falling back if a provider is no longer available. */
export function applySavedLineup(
  baseline: RecommendedLineup,
  saved: { roles: Record<string, string>; model_overrides?: Record<string, string> },
  selectableProviders: readonly string[],
  catalog: Pick<ModelCatalogResponse, 'models' | 'tier_recommendations' | 'role_tiers'> = BUILTIN_MODEL_CATALOG,
): RecommendedLineup {
  const allowed = new Set(selectableProviders);
  const roles: Record<string, string> = {};
  const model_overrides: Record<string, string> = {};
  for (const [role, defaultProvider] of Object.entries(baseline.roles)) {
    const savedProvider = saved.roles?.[role];
    const provider = savedProvider && allowed.has(savedProvider) ? savedProvider : defaultProvider;
    roles[role] = provider;
    const savedSpec = saved.model_overrides?.[role];
    const parsed = savedSpec ? parseRoleSpec(savedSpec, provider) : null;
    if (parsed && parsed.provider === provider && parsed.model) {
      const providerModels = modelsForProvider(catalog.models, provider);
      if (providerModels.length === 0 || providerModels.some((entry) => entry.id === parsed.model)) {
        model_overrides[role] = formatRoleSpec(provider, parsed.model, parsed.effort);
        continue;
      }
    }
    const rec = recommendRoleSpec(role, selectableProviders, catalog, provider);
    if (rec.model) {
      model_overrides[role] = formatRoleSpec(provider, rec.model, rec.effort);
    } else if (baseline.model_overrides?.[role] && provider === defaultProvider) {
      model_overrides[role] = baseline.model_overrides[role];
    }
  }
  return { ...baseline, roles, model_overrides };
}

/** Find a saved profile whose roles and model specs match `lineup`, or null when modified/unmatched. */
export function matchSavedProfile(
  profiles: readonly SavedLineupProfile[],
  lineup: RecommendedLineup | null,
): SavedLineupProfile | null {
  if (!lineup || profiles.length === 0) return null;
  const roleKeys = Object.keys(lineup.roles);
  if (roleKeys.length === 0) return null;
  return profiles.find((profile) => roleKeys.every((role) => (
    profile.roles?.[role] === lineup.roles[role]
    && (profile.model_overrides?.[role] ?? '') === (lineup.model_overrides?.[role] ?? '')
  ))) ?? null;
}

/** One line listing who plays each role (with model & effort when specified); falls back to notes. */
export function lineupSummary(
  lineup: RecommendedLineup,
  locale: Locale,
  models: readonly ModelCatalogEntry[] = BUILTIN_MODEL_CATALOG.models,
): string {
  const roles = Object.entries(lineup.roles).map(([role, provider]) => {
    const spec = lineup.model_overrides?.[role];
    if (!spec) return `${translateRole(role, locale)}: ${formatProviderDisplay(provider)}`;
    const parsed = parseRoleSpec(spec, provider);
    const modelLabel = models.find((m) => m.id === parsed.model)?.label ?? parsed.model;
    const effortLabel = parsed.effort ? (EFFORT_LABELS[parsed.effort] ?? parsed.effort) : '';
    const detail = modelLabel
      ? `${modelLabel}${effortLabel ? ` · ${effortLabel}` : ''} (${formatProviderDisplay(parsed.provider)})`
      : formatProviderDisplay(parsed.provider);
    return `${translateRole(role, locale)}: ${detail}`;
  });
  if (roles.length === 0) return lineupNotes(lineup, locale);
  return roles.join(locale === 'zh' ? '，' : ', ');
}

function lineupNotes(lineup: RecommendedLineup, locale: Locale): string {
  return formatProviderIdsInText(locale === 'zh' ? lineup.notes_zh : lineup.notes_en);
}

/** An install may run only for a missing CLI after explicit confirmation. */
export function canInstall(entry: Pick<CliScanEntry, 'status'> | undefined, consent: boolean): boolean {
  return consent === true && entry?.status === 'missing';
}

/** Runs the install recipe only when `canInstall` allows it; returns whether the API was called and succeeded. */
export async function installWithConsent(
  api: Pick<GuidedSetupApi, 'installCli'>,
  entry: CliScanEntry | undefined,
  consent: boolean,
): Promise<boolean> {
  if (!entry || !canInstall(entry, consent)) return false;
  const result = await api.installCli({ cliId: entry.id, confirmed: true });
  if (!result.ok) {
    throw new Error(result.output.trim() || `Install failed (exit ${result.returncode})`);
  }
  return true;
}

/** Turns on Git for the current workspace, then re-reads the workspace info. */
export async function initGitAndRefresh(
  api: Pick<GuidedSetupApi, 'initGitWorkspace' | 'getWorkspaceInfo'>,
): Promise<WorkspaceInfo> {
  await api.initGitWorkspace();
  return api.getWorkspaceInfo();
}

/**
 * Version-history state of the folder: the engine needs a git repo with at least one commit.
 * `unknown` (no info yet) never blocks.
 */
export function workspaceHistoryState(workspace: WorkspaceInfo | null): 'unknown' | 'missing' | 'no-commits' | 'ready' {
  if (!workspace) return 'unknown';
  if (!workspace.is_git_repo) return 'missing';
  return workspace.has_commits === false ? 'no-commits' : 'ready';
}

/** The team can be confirmed only when the folder's history lets a build start. */
export function historyAllowsBuild(workspace: WorkspaceInfo | null): boolean {
  const state = workspaceHistoryState(workspace);
  return state === 'unknown' || state === 'ready';
}

/** Hands the lineup to the next step only when it is ready; returns whether `onReady` fired. */
export function confirmLineup(lineup: RecommendedLineup | null, onReady: (lineup: RecommendedLineup) => void): boolean {
  if (!lineup?.ready) return false;
  onReady(lineup);
  return true;
}

function errorText(error: unknown, locale: Locale): string {
  return localizeGuidedError(error, locale);
}

export interface GuidedDriverRowProps {
  locale: Locale;
  driver: CliDriver;
  entry: CliScanEntry | undefined;
  /** Retained for callers using the previous row contract; installation now uses a popover. */
  consent?: boolean;
  busy: boolean;
  activeAction?: string | null;
  feedback?: string | null;
  needsApiKey?: string | null;
  login: CliLoginResult | null;
  onConsentChange?(consent: boolean): void;
  installOpen?: boolean;
  installError?: string | null;
  highlightSignIn?: boolean;
  onOpenInstall?(): void;
  onCancelInstall?(): void;
  onInstall(): void;
  onLogin(): void;
  onConfigureApiKey?: (envKey: string) => void;
}

/** One toolkit row: name, tier badge, status pill, diagnostics, and action. */
export function GuidedDriverRow({
  locale, driver, entry, busy, activeAction = null, feedback = null, needsApiKey = null, login,
  installOpen = false, installError = null, highlightSignIn = false,
  onOpenInstall, onCancelInstall, onInstall, onLogin, onConfigureApiKey,
}: GuidedDriverRowProps) {
  const copy = MESSAGES[locale].guided.setup;
  const status = entry?.status ?? 'missing';
  const reason = entry ? driverText(driver, locale === 'zh' ? entry.reason_zh : entry.reason_en) : '';
  const summary = driverText(driver, locale === 'zh' ? driver.summary_zh : driver.summary_en);
  const tierLabel = copy.tiers[driver.tier as keyof typeof copy.tiers] ?? driver.tier;
  const pill = status === 'ready' ? copy.ready : status === 'installed_unauthenticated' ? copy.needsLogin : copy.missing;
  const loginNote = login ? driverText(driver, locale === 'zh' ? login.message_zh : login.message_en) : '';
  const isInstalling = activeAction === `install:${driver.id}`;
  const isLoggingIn = activeAction === `login:${driver.id}`;

  return (
    <li className="guided-setup__driver" data-status={status}>
      <div className="guided-setup__driver-head">
        <span className="guided-setup__driver-name">{driverDisplayName(driver)}</span>
        <span className="guided-setup__tier" data-tier={driver.tier}>{tierLabel}</span>
        <span className="guided-setup__pill" data-status={status}>{pill}</span>
        {entry?.version ? <span className="guided-setup__version">{entry.version}</span> : null}
      </div>
      {status === 'ready' && (entry?.binary_path || summary) ? (
        <div className="guided-setup__meta">
          {summary ? <p className="guided-setup__reason">{summary}</p> : null}
          {entry?.binary_path ? <code className="guided-setup__binary">{entry.binary_path}</code> : null}
        </div>
      ) : null}
      {status === 'ready' && needsApiKey ? (
        <div className="guided-setup__api-hint" role="note">
          <span>{copy.needsApiKeyForTeam(needsApiKey)}</span>
          {onConfigureApiKey ? (
            <button
              type="button"
              className="guided-setup__button"
              disabled={busy}
              onClick={() => onConfigureApiKey(needsApiKey)}
            >
              {copy.configureApiKeyAction}
            </button>
          ) : null}
        </div>
      ) : null}
      {status !== 'ready' && reason ? <p className="guided-setup__reason">{reason}</p> : null}
      {status === 'missing' ? (
        <div className="guided-setup__actions">
          <button type="button" className="guided-setup__button" disabled={busy || !entry} onClick={onOpenInstall}>
            {isInstalling ? copy.installing : copy.install}
          </button>
          <InstallConfirmPopover driver={driver} open={installOpen} busy={busy} error={installError}
            onConfirm={onInstall} onCancel={() => onCancelInstall?.()} />
        </div>
      ) : null}
      {status === 'installed_unauthenticated' ? (
        <div className="guided-setup__actions">
          <button type="button" className={`guided-setup__button${highlightSignIn ? ' guided-setup__button--sign-in' : ''}`} disabled={busy} onClick={onLogin}>
            {isLoggingIn ? copy.openingLogin : copy.login}
          </button>
        </div>
      ) : null}
      {isInstalling || isLoggingIn ? (
        <div className="guided-setup__progress-wrap" role="status" aria-live="polite">
          <div className="guided-setup__progress" aria-hidden="true"><div className="guided-setup__progress-bar" /></div>
          <span className="guided-setup__progress-text">{isInstalling ? copy.installing : copy.openingLogin}</span>
        </div>
      ) : null}
      {feedback ? <p className="guided-setup__done-note" role="status">{feedback}</p> : null}
      {login ? (
        <p className="guided-setup__login-note">
          {loginNote}{' '}
          <a href={driver.official_url} target="_blank" rel="noreferrer">{driver.official_url}</a>
        </p>
      ) : null}
    </li>
  );
}

export interface GuidedSetupStepProps {
  locale: Locale;
  onReady(lineup: RecommendedLineup): void;
  /** Resolved client mode (`null` waits until `client.init()` completes before scanning). */
  apiMode?: ApiMode | null;
  /** Optional saved role->provider choices preserved when returning from Step 2. */
  initialRoles?: Record<string, string> | null;
  /** Optional saved role->`provider:model@effort` choices preserved when returning from Step 2. */
  initialModelOverrides?: Record<string, string> | null;
  /** Defaults to a `BatonApiClient`; tests pass a fake. */
  api?: GuidedSetupApi;
  /** Share the parent session owner so every queued write is flushed before a workspace switch. */
  guidedSession?: GuidedSessionState;
  /** Called after the selected workspace has been persisted. */
  onWorkspaceChanged?(workspace: WorkspaceInfo): void;
}

function hasSessionApi(api: GuidedSetupApi): api is GuidedSetupApi & GuidedSessionApi {
  return typeof api.getGuidedSession === 'function' && typeof api.saveGuidedSession === 'function'
    && typeof api.resetGuidedSession === 'function';
}

/** Guided step 1: choose a workspace, prepare Git and inspect the available coding tools. */
export function GuidedSetupStep(props: GuidedSetupStepProps) {
  const api = props.api ?? getDefaultApi();
  if (props.guidedSession) return <GuidedSetupBody {...props} api={api} guidedSession={props.guidedSession} />;
  if (props.apiMode !== null && hasSessionApi(api)) {
    return <GuidedSetupWithSession {...props} api={api} />;
  }
  return <GuidedSetupBody {...props} api={api} guidedSession={null} />;
}

function GuidedSetupWithSession(props: GuidedSetupStepProps & { api: GuidedSetupApi & GuidedSessionApi }) {
  const guidedSession = useGuidedSession(props.api);
  return <GuidedSetupBody {...props} guidedSession={guidedSession} />;
}

function GuidedSetupBody({
  locale, onReady, apiMode, initialRoles = null, initialModelOverrides = null, api, guidedSession, onWorkspaceChanged,
}: Omit<GuidedSetupStepProps, 'api' | 'guidedSession'> & { api: GuidedSetupApi; guidedSession: GuidedSessionState | null }) {
  const copy = MESSAGES[locale].guided.setup;
  const credentialLabels = MESSAGES[locale].credentials;
  const apiKeysCardRef = useRef<HTMLElement>(null);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [drivers, setDrivers] = useState<CliDriver[]>([]);
  const [entries, setEntries] = useState<Record<string, CliScanEntry>>({});
  const [httpApiKeysPresent, setHttpApiKeysPresent] = useState<string[]>([]);
  const [lineup, setLineup] = useState<RecommendedLineup | null>(null);
  const [configuredProviders, setConfiguredProviders] = useState<string[] | undefined>(undefined);
  const [modelCatalog, setModelCatalog] = useState<Pick<ModelCatalogResponse, 'models' | 'tier_recommendations' | 'role_tiers' | 'efforts'>>(
    () => BUILTIN_MODEL_CATALOG,
  );
  const cancelCatalogRefetch = useRef<(() => void) | null>(null);
  const [credentials, setCredentials] = useState<CredentialStatus[]>([]);
  const [apiKeysOpen, setApiKeysOpen] = useState(false);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [apiKeyFeedback, setApiKeyFeedback] = useState<string | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [customRoles, setCustomRoles] = useState<Record<string, string> | null>(() => initialRoles);
  const [customModelOverrides, setCustomModelOverrides] = useState<Record<string, string> | null>(() => initialModelOverrides);
  const [savedProfiles, setSavedProfiles] = useState<SavedLineupProfile[]>([]);
  const [driverFilter, setDriverFilter] = useState<DriverFilter>('all');
  const [scanResult, setScanResult] = useState<CliScanResult | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [installOpen, setInstallOpen] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [highlightSignIn, setHighlightSignIn] = useState<Record<string, boolean>>({});
  const [workspaceSaved, setWorkspaceSaved] = useState(true);
  const scanInFlight = useRef<{ path: string | undefined; generation: number; promise: Promise<void> } | null>(null);
  const scanGeneration = useRef(0);
  const mounted = useRef(true);
  const workspacePath = useRef<string | undefined>(undefined);
  const signInRefresh = useRef<{ driverId: string; state: 'starting' | 'waiting' | 'requested' } | null>(null);
  const installInFlight = useRef(false);
  const [logins, setLogins] = useState<Record<string, CliLoginResult>>({});
  const [workspaceFeedback, setWorkspaceFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyGeneration = useRef(0);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (key: string, task: () => Promise<void>) => {
    const generation = ++busyGeneration.current;
    setBusy(key);
    setError(null);
    try {
      await task();
    } catch (failure) {
      if (mounted.current) setError(errorText(failure, locale));
    } finally {
      if (mounted.current && generation === busyGeneration.current) setBusy(null);
    }
  }, [locale]);

  const scanRegistry = useCallback((repoPath?: string): Promise<void> => {
    const inFlight = scanInFlight.current;
    if (inFlight && inFlight.path === repoPath && inFlight.generation === scanGeneration.current) return inFlight.promise;
    const generation = ++scanGeneration.current;
    setScanning(true);
    const promise = api.scanCliRegistry(repoPath).then((result) => {
      if (!mounted.current || generation !== scanGeneration.current) return;
      if (signInRefresh.current && result.scan.drivers.some((entry) =>
        entry.id === signInRefresh.current?.driverId && entry.status === 'ready')) signInRefresh.current = null;
      setScanResult(result.scan);
      setEntries(Object.fromEntries(result.scan.drivers.map((entry) => [entry.id, entry])));
      setInstallOpen((current) => current && result.scan.drivers.some((entry) => entry.id === current && entry.status === 'missing') ? current : null);
      setHttpApiKeysPresent(result.scan.http_api_keys_present);
      setLineup(result.lineup);
    }).finally(() => {
      if (scanInFlight.current?.promise === promise) {
        scanInFlight.current = null;
        if (mounted.current) setScanning(false);
      }
    });
    scanInFlight.current = { path: repoPath, generation, promise };
    return promise;
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; scanGeneration.current += 1; signInRefresh.current = null; };
  }, []);

  useEffect(() => {
    workspacePath.current = workspace?.path;
  }, [workspace?.path]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onFocus = () => {
      const pending = signInRefresh.current;
      if (pending?.state === 'starting') {
        pending.state = 'requested';
      } else if (pending?.state === 'waiting') {
        void scanRegistry(workspacePath.current).catch((failure: unknown) => {
          if (mounted.current) setError(errorText(failure, locale));
        });
      }
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [locale, scanRegistry]);

  const applyRemoteCatalog = useCallback((catalog: ModelCatalogResponse) => {
    setModelCatalog(catalog);
  }, []);

  const scan = useCallback((repoPath?: string) => run('scan', () => scanRegistry(repoPath)), [run, scanRegistry]);

  useEffect(() => {
    if (apiMode === null) return;
    let active = true;
    void run('load', async () => {
      const [info, registry, rolesCfg, creds, remoteCatalog, lineupStore] = await Promise.all([
        api.getWorkspaceInfo(),
        api.getCliRegistry(),
        api.getRoles ? api.getRoles().catch(() => null) : Promise.resolve(null),
        api.listCredentials ? api.listCredentials().catch(() => []) : Promise.resolve([]),
        api.getModelCatalog ? api.getModelCatalog().catch(() => null) : Promise.resolve(null),
        api.getLineupProfiles ? api.getLineupProfiles().catch(() => null) : Promise.resolve(null),
      ]);
      if (!active) return;
      setWorkspace(info);
      setPathInput(info.path);
      setDrivers(registry.drivers);
      setConfiguredProviders(rolesCfg ? Object.keys(rolesCfg.providers) : undefined);
      setCredentials(creds);
      if (lineupStore) {
        setSavedProfiles(lineupStore.profiles);
        if (
          initialRoles === null
          && initialModelOverrides === null
          && lineupStore.last_used
          && Object.keys(lineupStore.last_used.roles).length > 0
        ) {
          setCustomRoles(lineupStore.last_used.roles);
          setCustomModelOverrides(lineupStore.last_used.model_overrides);
        }
      }
      if (remoteCatalog) {
        applyRemoteCatalog(remoteCatalog);
        cancelCatalogRefetch.current?.();
        cancelCatalogRefetch.current = scheduleStaleCatalogRefetch(remoteCatalog, () => {
          void api.getModelCatalog?.().then(applyRemoteCatalog).catch(() => {});
        });
      }
      await scanRegistry(info.path);
    });
    return () => { active = false; };
  }, [api, apiMode, initialModelOverrides, initialRoles, run, scanRegistry, applyRemoteCatalog]);

  useEffect(() => () => cancelCatalogRefetch.current?.(), []);

  const openApiKeyEditor = (envKey?: string) => {
    setApiKeysOpen(true);
    if (envKey) setFocusedKey(envKey);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        apiKeysCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    }
  };

  const saveApiKey = (key: string, value: string) => {
    if (!api.saveCredentials) return;
    void run(`apikey:${key}`, async () => {
      setApiKeyFeedback(null);
      const updated = await api.saveCredentials!({ [key]: value });
      setCredentials(updated);
      setKeyDrafts((current) => ({ ...current, [key]: '' }));
      await scanRegistry(workspace?.path);
      setApiKeyFeedback(copy.apiKeySaved);
    });
  };

  const refreshRolesConfig = useCallback(async () => {
    if (!api.getRoles) return;
    const rolesCfg = await api.getRoles().catch(() => null);
    setConfiguredProviders(rolesCfg ? Object.keys(rolesCfg.providers) : undefined);
  }, [api]);

  const rememberWorkspace = async (path: string) => {
    if (!guidedSession) return;
    guidedSession.save({ workspace_path: path });
    await guidedSession.flush();
  };

  const applyWorkspace = async (info: WorkspaceInfo) => {
    setWorkspaceSaved(false);
    scanGeneration.current += 1;
    workspacePath.current = info.path;
    setWorkspace(info);
    setPathInput(info.path);
    setCustomRoles(null);
    setCustomModelOverrides(null);
    setLineup(null);
    setEntries({});
    setScanResult(null);
    setDetailsOpen(false);
    signInRefresh.current = null;
    await rememberWorkspace(info.path);
    setWorkspaceSaved(true);
    onWorkspaceChanged?.(info);
    await Promise.all([scanRegistry(info.path), refreshRolesConfig()]);
    setWorkspaceFeedback(copy.folderSelected);
  };

  const selectFolder = () => run('workspace', async () => {
    setWorkspaceFeedback(null);
    if (guidedSession) await guidedSession.flush();
    const info = await api.selectWorkspace(pathInput.trim());
    await applyWorkspace(info);
  });

  const browseFolder = () => run('browse', async () => {
    setWorkspaceFeedback(null);
    if (!api.browseWorkspace) {
      await selectFolder();
      return;
    }
    if (guidedSession) await guidedSession.flush();
    const picked = await api.browseWorkspace();
    if (picked.cancelled) return;
    await applyWorkspace(picked.workspace);
  });

  const initGit = () => run('git', async () => {
    const repairing = workspaceHistoryState(workspace) === 'no-commits';
    setWorkspaceFeedback(null);
    setWorkspace(await initGitAndRefresh(api));
    setWorkspaceFeedback(repairing ? copy.firstCommitDone : copy.gitEnabledDone);
  });

  const install = (driver: CliDriver) => {
    if (installOpen !== driver.id || installInFlight.current || busy !== null || scanning) return;
    const currentEntry = entries[driver.id];
    if (!canInstall(currentEntry, true)) return;
    installInFlight.current = true;
    setInstallError(null);
    setBusy(`install:${driver.id}`);
    void (async () => {
      try {
        await installWithConsent(api, currentEntry, true);
        if (!mounted.current) return;
        const installed = { ...currentEntry!, status: 'installed_unauthenticated' as const, reason_en: '', reason_zh: '' };
        setEntries((current) => ({ ...current, [driver.id]: installed }));
        setScanResult((current) => current ? {
          ...current, drivers: current.drivers.map((item) => item.id === driver.id ? installed : item),
        } : current);
        setHighlightSignIn((current) => ({ ...current, [driver.id]: true }));
        setInstallOpen(null);
      } catch (failure) {
        if (mounted.current) setInstallError(errorText(failure, locale));
      } finally {
        installInFlight.current = false;
        if (mounted.current) setBusy(null);
      }
    })();
  };

  const login = (driver: CliDriver) => run(`login:${driver.id}`, async () => {
    signInRefresh.current = { driverId: driver.id, state: 'starting' };
    let result: CliLoginResult;
    try {
      result = await api.loginCli(driver.id);
    } catch (failure) {
      signInRefresh.current = null;
      throw failure;
    }
    if (!mounted.current) return;
    setLogins((current) => ({ ...current, [driver.id]: result }));
    if (result.launched) setHighlightSignIn((current) => ({ ...current, [driver.id]: false }));
    if (!result.launched) {
      signInRefresh.current = null;
    } else if (signInRefresh.current?.state === 'requested') {
      signInRefresh.current.state = 'waiting';
      await scanRegistry(workspacePath.current);
    } else if (signInRefresh.current) {
      signInRefresh.current.state = 'waiting';
    }
  });

  const selectableProviders = useMemo(
    () => availableLineupProviders(lineup, drivers, entries, configuredProviders, httpApiKeysPresent),
    [configuredProviders, drivers, entries, httpApiKeysPresent, lineup],
  );

  const pendingApiDrivers = useMemo(
    () => driversNeedingApiKey(drivers, entries, httpApiKeysPresent),
    [drivers, entries, httpApiKeysPresent],
  );
  const pendingApiKeyByDriver = useMemo(
    () => Object.fromEntries(pendingApiDrivers.map(({ driver, envKey }) => [driver.id, envKey])),
    [pendingApiDrivers],
  );
  const credentialsByKey = useMemo(
    () => Object.fromEntries(credentials.map((status) => [status.provider_key, status])),
    [credentials],
  );
  const orderedKeys = useMemo(() => {
    const known = new Set<string>(API_KEY_ORDER);
    const extras = credentials.map((c) => c.provider_key).filter((key) => !known.has(key));
    return [...API_KEY_ORDER, ...extras];
  }, [credentials]);
  const configuredKeyCount = credentials.filter((status) => status.configured).length;

  const baselineLineup = useMemo<RecommendedLineup | null>(
    () => (lineup && lineup.ready ? buildTieredLineup(lineup, selectableProviders, modelCatalog) : lineup),
    [lineup, modelCatalog, selectableProviders],
  );

  const effectiveLineup = useMemo<RecommendedLineup | null>(() => {
    if (!baselineLineup || !baselineLineup.ready) return baselineLineup;
    if (!customRoles && !customModelOverrides) return baselineLineup;
    const allowed = new Set(selectableProviders);
    const nextRoles: Record<string, string> = {};
    const nextOverrides: Record<string, string> = {};
    for (const [role, defaultProvider] of Object.entries(baselineLineup.roles)) {
      const overrideProvider = customRoles?.[role];
      const chosenProvider = overrideProvider && allowed.has(overrideProvider) ? overrideProvider : defaultProvider;
      nextRoles[role] = chosenProvider;
      const spec = customModelOverrides?.[role];
      const baseSpec = baselineLineup.model_overrides?.[role];
      if (spec) {
        const parsed = parseRoleSpec(spec, chosenProvider);
        if (parsed.provider === chosenProvider) {
          nextOverrides[role] = formatRoleSpec(chosenProvider, parsed.model, parsed.effort);
        } else {
          const rec = recommendRoleSpec(role, selectableProviders, modelCatalog, chosenProvider);
          if (rec.model) nextOverrides[role] = formatRoleSpec(chosenProvider, rec.model, rec.effort);
        }
      } else if (chosenProvider !== defaultProvider) {
        const rec = recommendRoleSpec(role, selectableProviders, modelCatalog, chosenProvider);
        if (rec.model) nextOverrides[role] = formatRoleSpec(chosenProvider, rec.model, rec.effort);
      } else if (baseSpec) {
        nextOverrides[role] = baseSpec;
      }
    }
    return { ...baselineLineup, roles: nextRoles, model_overrides: nextOverrides };
  }, [baselineLineup, customModelOverrides, customRoles, modelCatalog, selectableProviders]);

  const matchedProfile = useMemo(
    () => matchSavedProfile(savedProfiles, effectiveLineup),
    [effectiveLineup, savedProfiles],
  );

  const handleConfirmLineup = () => {
    if (!effectiveLineup?.ready || !historyAllowsBuild(workspace) || !workspaceSaved) return;
    void run('continue', async () => {
      if (workspace?.path) await rememberWorkspace(workspace.path);
      if (api.saveLastUsedLineup) {
        void api.saveLastUsedLineup({
          roles: effectiveLineup.roles,
          model_overrides: effectiveLineup.model_overrides ?? {},
          profile_id: matchedProfile?.id ?? null,
          profile_name: matchedProfile?.name ?? null,
        }).catch(() => {});
      }
      // A hand-changed team is kept by the Blueprint recommendation; an untouched one follows the project size.
      confirmLineup({ ...effectiveLineup, customized: isLineupCustomized(baselineLineup, effectiveLineup) }, onReady);
    });
  };

  const readyCount = drivers.filter((driver) => entries[driver.id]?.status === 'ready').length;
  const previousReadyCount = useRef(0);
  useEffect(() => {
    if (readyCount === 0 || previousReadyCount.current === 0) setDetailsOpen(false);
    previousReadyCount.current = readyCount;
  }, [readyCount]);
  const visibleDrivers = filterDrivers(drivers, entries, driverFilter);
  const isBusy = busy !== null || scanning;
  const sessionUnavailable = Boolean(guidedSession && !guidedSession.session);

  const historyState = workspaceHistoryState(workspace);
  const workspaceBusyLabel = busy === 'browse'
    ? copy.browsing
    : busy === 'workspace'
      ? copy.switchingFolder
      : busy === 'git'
        ? copy.initializingGit
        : null;

  return (
    <div className="guided-setup">
      <section className="guided-setup__card">
        <div className="guided-setup__row guided-setup__row--spread">
          <h3 className="guided-setup__title">{copy.currentFolder}</h3>
          <button
            type="button"
            className="guided-setup__button guided-setup__button--primary"
            disabled={isBusy || sessionUnavailable}
            onClick={() => void browseFolder()}
          >
            {busy === 'browse' ? copy.browsing : copy.pickFolder}
          </button>
        </div>
        {workspace ? <p className="guided-setup__path"><code>{workspace.path}</code></p> : null}
        <div className="guided-setup__row">
          <input
            className="guided-setup__input"
            value={pathInput}
            aria-label={copy.currentFolder}
            onChange={(event) => setPathInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !isBusy && !sessionUnavailable && pathInput.trim() !== '') {
                event.preventDefault();
                void selectFolder();
              }
            }}
          />
          <button
            type="button"
            className="guided-setup__button"
            disabled={isBusy || sessionUnavailable || pathInput.trim() === ''}
            onClick={() => void selectFolder()}
          >
            {busy === 'workspace' ? copy.switchingFolder : copy.applyPath}
          </button>
        </div>
        {workspaceBusyLabel ? (
          <div className="guided-setup__progress-wrap" role="status" aria-live="polite">
            <div className="guided-setup__progress" aria-hidden="true"><div className="guided-setup__progress-bar" /></div>
            <span className="guided-setup__progress-text">{workspaceBusyLabel}</span>
          </div>
        ) : null}
        {workspaceFeedback ? <p className="guided-setup__done-note" role="status">{workspaceFeedback}</p> : null}
        {workspace ? (
          <p className="guided-setup__git" data-git={historyState === 'ready'}>
            {historyState === 'ready' ? copy.gitReady : historyState === 'no-commits' ? copy.firstCommitMissing : copy.gitMissing}
          </p>
        ) : null}
        {historyState === 'missing' || historyState === 'no-commits' ? (
          <button type="button" className="guided-setup__button guided-setup__button--primary" disabled={isBusy || sessionUnavailable} onClick={() => void initGit()}>
            {historyState === 'no-commits'
              ? (busy === 'git' ? copy.creatingFirstCommit : copy.createFirstCommit)
              : (busy === 'git' ? copy.initializingGit : copy.initGit)}
          </button>
        ) : null}
      </section>

      {readyCount > 0 ? (
        <CliSummaryBar scan={scanResult} scanning={isBusy} onScan={() => void scan(workspace?.path)}
          onOpenDetails={() => setDetailsOpen(true)} />
      ) : null}
      {readyCount === 0 || detailsOpen ? (
        <section className="guided-setup__card">
          <div className="guided-setup__row guided-setup__row--spread guided-setup__row--wrap">
            <div className="guided-setup__title-group">
              <h3 className="guided-setup__title">{copy.scanClis}</h3>
              {drivers.length > 0 ? <span className="guided-setup__count" data-ready={readyCount > 0}>
                {copy.scanSummary(readyCount, drivers.length)}
              </span> : null}
            </div>
            <div className="guided-setup__actions">
              <button type="button" className="guided-setup__button" disabled={isBusy} onClick={() => void scan(workspace?.path)}>
                {scanning || busy === 'load' ? copy.scanning : copy.scanClis}
              </button>
              {readyCount > 0 ? <button type="button" className="guided-setup__button"
                onClick={() => { setDetailsOpen(false); setInstallOpen(null); }}>
                {MESSAGES[locale].glossary.close}
              </button> : null}
            </div>
          </div>
          {drivers.length > 0 ? (
            <div className="guided-setup__filters" role="group" aria-label={copy.scanClis}>
              {([
                ['all', copy.filterAll], ['ready', copy.filterReady], ['needs_setup', copy.filterNeedsSetup],
              ] as const).map(([key, label]) => (
                <button key={key} type="button" className="guided-setup__chip" aria-pressed={driverFilter === key}
                  onClick={() => setDriverFilter(key)}>{label}</button>
              ))}
            </div>
          ) : null}
          {scanning || busy === 'load' ? (
            <div className="guided-setup__progress-wrap" role="status" aria-live="polite">
              <div className="guided-setup__progress" aria-hidden="true"><div className="guided-setup__progress-bar" /></div>
              <span className="guided-setup__progress-text">{copy.scanning}</span>
            </div>
          ) : null}
          <ul className="guided-setup__drivers">
            {visibleDrivers.map((driver) => (
              <GuidedDriverRow key={driver.id} locale={locale} driver={driver} entry={entries[driver.id]}
                busy={isBusy} activeAction={busy}
                needsApiKey={pendingApiKeyByDriver[driver.id] ?? null} login={logins[driver.id] ?? null}
                installOpen={installOpen === driver.id} installError={installOpen === driver.id ? installError : null}
                highlightSignIn={highlightSignIn[driver.id] === true}
                onOpenInstall={() => { setInstallError(null); setInstallOpen(driver.id); }}
                onCancelInstall={() => { if (!installInFlight.current) setInstallOpen(null); }}
                onInstall={() => install(driver)} onLogin={() => void login(driver)}
                onConfigureApiKey={api.listCredentials ? (envKey) => openApiKeyEditor(envKey) : undefined} />
            ))}
          </ul>
        </section>
      ) : null}

      {api.listCredentials ? (
        <section className="guided-setup__card" ref={apiKeysCardRef}>
          <div className="guided-setup__row guided-setup__row--spread guided-setup__row--wrap">
            <div className="guided-setup__title-group">
              <h3 className="guided-setup__title">{copy.apiKeysTitle}</h3>
              {credentials.length > 0 ? (
                <span className="guided-setup__count" data-ready={configuredKeyCount > 0}>
                  {copy.apiKeysSummary(configuredKeyCount, orderedKeys.length)}
                </span>
              ) : null}
            </div>
            <button
              type="button"
              className="guided-setup__button"
              aria-expanded={apiKeysOpen}
              onClick={() => setApiKeysOpen((open) => !open)}
            >
              {apiKeysOpen ? copy.apiKeysHide : copy.apiKeysShow}
            </button>
          </div>
          <p className="guided-setup__reason">{copy.apiKeysNote}</p>
          {busy?.startsWith('apikey:') ? (
            <div className="guided-setup__progress-wrap" role="status" aria-live="polite">
              <div className="guided-setup__progress" aria-hidden="true"><div className="guided-setup__progress-bar" /></div>
              <span className="guided-setup__progress-text">{copy.apiKeySaving}</span>
            </div>
          ) : null}
          {apiKeyFeedback ? <p className="guided-setup__done-note" role="status">{apiKeyFeedback}</p> : null}
          {apiKeysOpen ? (
            <ul className="guided-setup__api-list">
              {orderedKeys.map((key) => {
                const status = credentialsByKey[key];
                const label = credentialLabels.keyLabels[key as keyof typeof credentialLabels.keyLabels] ?? key;
                const draft = keyDrafts[key] ?? '';
                const isSavingThis = busy === `apikey:${key}`;
                const badgeText = status?.configured
                  ? (status.source === 'env' ? `${copy.apiKeyEnvSource} · ${status.masked}` : status.masked)
                  : copy.apiKeyMissing;
                return (
                  <li
                    key={key}
                    className={`guided-setup__api-row${focusedKey === key ? ' guided-setup__api-row--highlight' : ''}`}
                    data-configured={status?.configured === true}
                  >
                    <div className="guided-setup__row guided-setup__row--spread guided-setup__row--wrap">
                      <label className="guided-setup__role-label" htmlFor={`guided-key-${key}`}>
                        {label} <code>{key}</code>
                      </label>
                      <span className="guided-setup__pill" data-status={status?.configured ? 'ready' : 'missing'}>
                        {badgeText}
                      </span>
                    </div>
                    <form
                      className="guided-setup__row"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (draft.trim() && busy === null) saveApiKey(key, draft.trim());
                      }}
                    >
                      <input
                        id={`guided-key-${key}`}
                        type="password"
                        autoComplete="new-password"
                        spellCheck={false}
                        className="guided-setup__input"
                        value={draft}
                        placeholder={copy.apiKeyPlaceholder}
                        disabled={isBusy || sessionUnavailable}
                        onChange={(event) => setKeyDrafts((current) => ({ ...current, [key]: event.target.value }))}
                      />
                      <button
                        type="submit"
                        className="guided-setup__button guided-setup__button--primary"
                        disabled={busy !== null || !draft.trim()}
                      >
                        {isSavingThis ? copy.apiKeySaving : credentialLabels.save}
                      </button>
                      {status?.source === 'local_file' ? (
                        <button
                          type="button"
                          className="guided-setup__button"
                          disabled={isBusy || sessionUnavailable}
                          onClick={() => saveApiKey(key, '')}
                        >
                          {credentialLabels.clear}
                        </button>
                      ) : null}
                    </form>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>
      ) : null}

      {effectiveLineup ? (
        <section className="guided-setup__card" data-ready={effectiveLineup.ready}>
          {effectiveLineup.ready ? (
            <>
              <p className="guided-setup__lineup">{lineupNotes(effectiveLineup, locale)}</p>
              <p className="guided-setup__reason">
                {locale === 'zh'
                  ? '在下一步中，L0 架构伙伴完成蓝图后会自动推荐工作流，届时你可以直接在蓝图卡底部自定义各角色模型或加载已保存的工作流方案。'
                  : 'In the next step, VibeBaton recommends a workflow once the blueprint is ready, and lets you customize every role model or load saved presets.'}
              </p>
              <div className="guided-setup__team-actions">
                <button type="button" className="guided-setup__button guided-setup__button--primary"
                  disabled={isBusy || sessionUnavailable || !workspaceSaved || !historyAllowsBuild(workspace)}
                  onClick={handleConfirmLineup}>
                  {copy.useLineup}
                </button>
                {!historyAllowsBuild(workspace) ? <p className="guided-setup__git" data-git={false}>{copy.continueNeedsHistory}</p> : null}
              </div>
            </>
          ) : <p className="guided-setup__next">{lineupNotes(effectiveLineup, locale)}</p>}
          {pendingApiDrivers.length > 0 ? (
            <div className="guided-setup__api-hint" role="note">
              <span>{copy.teamNeedsApiKeyNote(
                pendingApiDrivers.map(({ driver }) => driverDisplayName(driver)).join(locale === 'zh' ? '、' : ', '),
                [...new Set(pendingApiDrivers.map(({ envKey }) => envKey))].join(locale === 'zh' ? '、' : ', '),
              )}</span>
              {api.listCredentials ? <button type="button" className="guided-setup__button" disabled={isBusy}
                onClick={() => openApiKeyEditor(pendingApiDrivers[0]?.envKey)}>{copy.configureApiKeyAction}</button> : null}
            </div>
          ) : null}
        </section>
      ) : null}
      {guidedSession?.error ? <p className="guided-setup__error" role="alert">{errorText(guidedSession.error, locale)}</p> : null}

      {error ? <p className="guided-setup__error" role="alert">{error}</p> : null}
    </div>
  );
}
