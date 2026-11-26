import './GuidedSetupStep.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BatonApiClient,
  type ApiMode,
  type CliDriver,
  type CliLoginResult,
  type CliScanEntry,
  type LastUsedLineup,
  type ModelCatalogEntry,
  type ModelCatalogResponse,
  type RecommendedLineup,
  type SavedLineupProfile,
  type TierRecommendation,
  type WorkspaceInfo,
} from '../../api/client';
import { MESSAGES, type Locale } from '../../i18n/messages';
import { formatProviderDisplay, translateRole } from '../../i18n/presets';
import type { CredentialStatus } from '../../types/graph';
import { localizeGuidedError } from './guidedErrors';

/** The client methods this step needs; inject a fake in tests. */
export type GuidedSetupApi = Pick<
  BatonApiClient,
  'getWorkspaceInfo' | 'selectWorkspace' | 'initGitWorkspace' | 'getCliRegistry' | 'scanCliRegistry' | 'installCli' | 'loginCli'
> & Partial<Pick<
  BatonApiClient,
  'browseWorkspace' | 'getRoles' | 'listCredentials' | 'saveCredentials' | 'getModelCatalog' | 'syncModelCatalog'
  | 'getLineupProfiles' | 'saveLineupProfile' | 'deleteLineupProfile' | 'saveLastUsedLineup'
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
): ModelCatalogEntry {
  return { id, label, family, providers, status, cost_tier, rank, efforts: ALL_EFFORT_IDS, default_effort };
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
    builtinEntry('deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 'deepseek', ['dsh_opencode'], 'latest', 'eco', 1, 'max'),
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
  return (locale === 'zh' ? lineup.notes_zh : lineup.notes_en).replace(DSH_TEXT_RE, 'DSH');
}

/** Install is offered only for a missing CLI, and only after the user ticked the consent box. */
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
  consent: boolean;
  busy: boolean;
  activeAction?: string | null;
  feedback?: string | null;
  needsApiKey?: string | null;
  login: CliLoginResult | null;
  onConsentChange(consent: boolean): void;
  onInstall(): void;
  onLogin(): void;
  onConfigureApiKey?: (envKey: string) => void;
}

/** One toolkit row: name, tier badge, status pill, diagnostics, and action. */
export function GuidedDriverRow({
  locale, driver, entry, consent, busy, activeAction = null, feedback = null, needsApiKey = null, login,
  onConsentChange, onInstall, onLogin, onConfigureApiKey,
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
          <label className="guided-setup__consent">
            <input type="checkbox" checked={consent} disabled={busy} onChange={(event) => onConsentChange(event.target.checked)} />
            <span>{copy.installConsent}</span>
            <code>{driverText(driver, driver.install_cmd.join(' '))}</code>
          </label>
          <button type="button" className="guided-setup__button" disabled={busy || !canInstall(entry, consent)} onClick={onInstall}>
            {isInstalling ? copy.installing : copy.install}
          </button>
        </div>
      ) : null}
      {status === 'installed_unauthenticated' ? (
        <div className="guided-setup__actions">
          <button type="button" className="guided-setup__button" disabled={busy} onClick={onLogin}>
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
}

/** Guided step 1: pick the workspace, turn on Git, inspect/install AI coding tools, and customize the team. */
export function GuidedSetupStep({
  locale, onReady, apiMode, initialRoles = null, initialModelOverrides = null, api: injectedApi,
}: GuidedSetupStepProps) {
  const api = injectedApi ?? getDefaultApi();
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
  const [providerCommands, setProviderCommands] = useState<Record<string, string[]>>({});
  const [modelCatalog, setModelCatalog] = useState<Pick<ModelCatalogResponse, 'models' | 'tier_recommendations' | 'role_tiers' | 'efforts'>>(
    () => BUILTIN_MODEL_CATALOG,
  );
  const [catalogFeedback, setCatalogFeedback] = useState<string | null>(null);
  const [catalogSyncFailed, setCatalogSyncFailed] = useState(false);
  const cancelCatalogRefetch = useRef<(() => void) | null>(null);
  const [credentials, setCredentials] = useState<CredentialStatus[]>([]);
  const [apiKeysOpen, setApiKeysOpen] = useState(false);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [apiKeyFeedback, setApiKeyFeedback] = useState<string | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [customRoles, setCustomRoles] = useState<Record<string, string> | null>(() => initialRoles);
  const [customModelOverrides, setCustomModelOverrides] = useState<Record<string, string> | null>(() => initialModelOverrides);
  const [savedProfiles, setSavedProfiles] = useState<SavedLineupProfile[]>([]);
  const [lastUsedLineup, setLastUsedLineup] = useState<LastUsedLineup | null>(null);
  const [lastUsedApplied, setLastUsedApplied] = useState(false);
  const [profileNameInput, setProfileNameInput] = useState('');
  const [profileFeedback, setProfileFeedback] = useState<string | null>(null);
  const [roleEditorOpen, setRoleEditorOpen] = useState(false);
  const [driverFilter, setDriverFilter] = useState<DriverFilter>('all');
  const [consent, setConsent] = useState<Record<string, boolean>>({});
  const [logins, setLogins] = useState<Record<string, CliLoginResult>>({});
  const [installFeedback, setInstallFeedback] = useState<Record<string, string>>({});
  const [workspaceFeedback, setWorkspaceFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (key: string, task: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await task();
    } catch (failure) {
      setError(errorText(failure, locale));
    } finally {
      setBusy(null);
    }
  }, [locale]);

  const scanRegistry = useCallback(async (repoPath?: string) => {
    const result = await api.scanCliRegistry(repoPath);
    setEntries(Object.fromEntries(result.scan.drivers.map((entry) => [entry.id, entry])));
    setHttpApiKeysPresent(result.scan.http_api_keys_present);
    setLineup(result.lineup);
  }, [api]);

  const applyRemoteCatalog = useCallback((catalog: ModelCatalogResponse) => {
    setModelCatalog(catalog);
    setCatalogSyncFailed(Boolean(catalog.cache?.last_error));
  }, []);

  const scan = useCallback((repoPath?: string) => run('scan', () => scanRegistry(repoPath)), [run, scanRegistry]);

  useEffect(() => {
    if (apiMode === null) return;
    void run('load', async () => {
      const [info, registry, rolesCfg, creds, remoteCatalog, lineupStore] = await Promise.all([
        api.getWorkspaceInfo(),
        api.getCliRegistry(),
        api.getRoles ? api.getRoles().catch(() => null) : Promise.resolve(null),
        api.listCredentials ? api.listCredentials().catch(() => []) : Promise.resolve([]),
        api.getModelCatalog ? api.getModelCatalog().catch(() => null) : Promise.resolve(null),
        api.getLineupProfiles ? api.getLineupProfiles().catch(() => null) : Promise.resolve(null),
      ]);
      setWorkspace(info);
      setPathInput(info.path);
      setDrivers(registry.drivers);
      setConfiguredProviders(rolesCfg ? Object.keys(rolesCfg.providers) : undefined);
      setProviderCommands(rolesCfg
        ? Object.fromEntries(Object.entries(rolesCfg.providers).map(([id, provider]) => [id, provider.command ?? []]))
        : {});
      setCredentials(creds);
      if (lineupStore) {
        setSavedProfiles(lineupStore.profiles);
        setLastUsedLineup(lineupStore.last_used);
        if (
          initialRoles === null
          && initialModelOverrides === null
          && lineupStore.last_used
          && Object.keys(lineupStore.last_used.roles).length > 0
        ) {
          setCustomRoles(lineupStore.last_used.roles);
          setCustomModelOverrides(lineupStore.last_used.model_overrides);
          setLastUsedApplied(true);
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
  }, [api, apiMode, initialModelOverrides, initialRoles, run, scanRegistry, applyRemoteCatalog]);

  useEffect(() => () => cancelCatalogRefetch.current?.(), []);

  const syncModels = () => {
    if (!api.syncModelCatalog) return;
    void run('models_sync', async () => {
      setCatalogFeedback(null);
      const res = await api.syncModelCatalog!(true);
      applyRemoteCatalog(res.catalog);
      setCatalogFeedback(res.ok ? copy.modelsSyncedDone(res.added_count) : copy.modelsSyncFailed);
    });
  };

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

  const selectFolder = () => run('workspace', async () => {
    setWorkspaceFeedback(null);
    const info = await api.selectWorkspace(pathInput.trim());
    setWorkspace(info);
    setPathInput(info.path);
    setCustomRoles(null);
    setCustomModelOverrides(null);
    await Promise.all([scanRegistry(info.path), refreshRolesConfig()]);
    setWorkspaceFeedback(copy.folderSelected);
  });

  const browseFolder = () => run('browse', async () => {
    setWorkspaceFeedback(null);
    if (!api.browseWorkspace) {
      await selectFolder();
      return;
    }
    const picked = await api.browseWorkspace();
    if (picked.cancelled) return;
    setWorkspace(picked.workspace);
    setPathInput(picked.workspace.path);
    setCustomRoles(null);
    setCustomModelOverrides(null);
    await Promise.all([scanRegistry(picked.workspace.path), refreshRolesConfig()]);
    setWorkspaceFeedback(copy.folderSelected);
  });

  const initGit = () => run('git', async () => {
    setWorkspaceFeedback(null);
    setWorkspace(await initGitAndRefresh(api));
    setWorkspaceFeedback(copy.gitEnabledDone);
  });

  const install = (driver: CliDriver) => run(`install:${driver.id}`, async () => {
    setInstallFeedback((current) => {
      const next = { ...current };
      delete next[driver.id];
      return next;
    });
    if (await installWithConsent(api, entries[driver.id], consent[driver.id] === true)) {
      setConsent((current) => ({ ...current, [driver.id]: false }));
      await scanRegistry(workspace?.path);
      setInstallFeedback((current) => ({ ...current, [driver.id]: copy.installedDone }));
    }
  });

  const login = (driver: CliDriver) => run(`login:${driver.id}`, async () => {
    const result = await api.loginCli(driver.id);
    setLogins((current) => ({ ...current, [driver.id]: result }));
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

  const resetCustomization = () => {
    setCustomRoles(null);
    setCustomModelOverrides(null);
    setLastUsedApplied(false);
    setProfileFeedback(null);
  };

  const applyCustomLineup = (updated: RecommendedLineup) => {
    setCustomRoles(updated.roles);
    setCustomModelOverrides(updated.model_overrides ?? null);
    setLastUsedApplied(false);
    setProfileFeedback(null);
  };

  const matchedProfile = useMemo(
    () => matchSavedProfile(savedProfiles, effectiveLineup),
    [effectiveLineup, savedProfiles],
  );

  const applyProfile = (profile: SavedLineupProfile) => {
    if (!baselineLineup) return;
    applyCustomLineup(applySavedLineup(baselineLineup, profile, selectableProviders, modelCatalog));
    setProfileFeedback(copy.profileApplied(profile.name));
  };

  const saveCurrentProfile = () => {
    if (!api.saveLineupProfile || !effectiveLineup || !effectiveLineup.ready) return;
    const cleanName = profileNameInput.trim();
    if (!cleanName) return;
    void run('save_profile', async () => {
      setProfileFeedback(null);
      const res = await api.saveLineupProfile!({
        name: cleanName,
        roles: effectiveLineup.roles,
        model_overrides: effectiveLineup.model_overrides ?? {},
      });
      setSavedProfiles(res.profiles);
      setLastUsedLineup(res.last_used);
      setProfileNameInput('');
      setProfileFeedback(copy.profileSaved(res.profile.name));
    });
  };

  const removeSavedProfile = (profileId: string) => {
    if (!api.deleteLineupProfile) return;
    void run(`delete_profile:${profileId}`, async () => {
      const res = await api.deleteLineupProfile!(profileId);
      setSavedProfiles(res.profiles);
      setLastUsedLineup(res.last_used);
    });
  };

  const handleConfirmLineup = () => {
    if (!effectiveLineup || !effectiveLineup.ready) return;
    if (api.saveLastUsedLineup) {
      void api.saveLastUsedLineup({
        roles: effectiveLineup.roles,
        model_overrides: effectiveLineup.model_overrides ?? {},
        profile_id: matchedProfile?.id ?? null,
        profile_name: matchedProfile?.name ?? null,
      }).catch(() => {});
    }
    confirmLineup(effectiveLineup, onReady);
  };

  const isCustomized = isLineupCustomized(baselineLineup, effectiveLineup);
  const readyCount = drivers.filter((driver) => entries[driver.id]?.status === 'ready').length;
  const visibleDrivers = filterDrivers(drivers, entries, driverFilter);

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
            disabled={busy !== null}
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
              if (event.key === 'Enter' && busy === null && pathInput.trim() !== '') {
                event.preventDefault();
                void selectFolder();
              }
            }}
          />
          <button
            type="button"
            className="guided-setup__button"
            disabled={busy !== null || pathInput.trim() === ''}
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
          <p className="guided-setup__git" data-git={workspace.is_git_repo}>
            {workspace.is_git_repo ? copy.gitReady : copy.gitMissing}
          </p>
        ) : null}
        {workspace && !workspace.is_git_repo ? (
          <button type="button" className="guided-setup__button guided-setup__button--primary" disabled={busy !== null} onClick={() => void initGit()}>
            {busy === 'git' ? copy.initializingGit : copy.initGit}
          </button>
        ) : null}
      </section>

      <section className="guided-setup__card">
        <div className="guided-setup__row guided-setup__row--spread guided-setup__row--wrap">
          <div className="guided-setup__title-group">
            <h3 className="guided-setup__title">{copy.scanClis}</h3>
            {drivers.length > 0 ? (
              <span className="guided-setup__count" data-ready={readyCount > 0}>
                {copy.scanSummary(readyCount, drivers.length)}
              </span>
            ) : null}
          </div>
          <button type="button" className="guided-setup__button" disabled={busy !== null} onClick={() => void scan(workspace?.path)}>
            {busy === 'scan' || busy === 'load' ? copy.scanning : copy.scanClis}
          </button>
        </div>
        {drivers.length > 0 ? (
          <div className="guided-setup__filters" role="group" aria-label={copy.scanClis}>
            {([
              ['all', copy.filterAll],
              ['ready', copy.filterReady],
              ['needs_setup', copy.filterNeedsSetup],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className="guided-setup__chip"
                aria-pressed={driverFilter === key}
                onClick={() => setDriverFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
        {busy === 'scan' || busy === 'load' ? (
          <div className="guided-setup__progress-wrap" role="status" aria-live="polite">
            <div className="guided-setup__progress" aria-hidden="true"><div className="guided-setup__progress-bar" /></div>
            <span className="guided-setup__progress-text">{copy.scanning}</span>
          </div>
        ) : null}
        <ul className="guided-setup__drivers">
          {visibleDrivers.map((driver) => (
            <GuidedDriverRow
              key={driver.id}
              locale={locale}
              driver={driver}
              entry={entries[driver.id]}
              consent={consent[driver.id] === true}
              busy={busy !== null}
              activeAction={busy}
              feedback={installFeedback[driver.id] ?? null}
              needsApiKey={pendingApiKeyByDriver[driver.id] ?? null}
              login={logins[driver.id] ?? null}
              onConsentChange={(value) => setConsent((current) => ({ ...current, [driver.id]: value }))}
              onInstall={() => void install(driver)}
              onLogin={() => void login(driver)}
              onConfigureApiKey={api.listCredentials ? (envKey) => openApiKeyEditor(envKey) : undefined}
            />
          ))}
        </ul>
      </section>

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
                        disabled={busy !== null}
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
                          disabled={busy !== null}
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
          <div className="guided-setup__row guided-setup__row--spread guided-setup__row--wrap">
            <div className="guided-setup__title-group">
              <h3 className="guided-setup__title">{effectiveLineup.ready ? copy.lineupReady : copy.lineupMissing}</h3>
              {lastUsedApplied && (matchedProfile?.name ?? lastUsedLineup?.profile_name) ? (
                <span className="guided-setup__pill" data-status="ready">
                  {copy.lastUsedNamedBadge((matchedProfile?.name ?? lastUsedLineup?.profile_name)!)}
                </span>
              ) : lastUsedApplied ? (
                <span className="guided-setup__pill" data-status="ready">{copy.lastUsedBadge}</span>
              ) : matchedProfile ? (
                <span className="guided-setup__pill" data-status="ready">{matchedProfile.name}</span>
              ) : isCustomized ? (
                <span className="guided-setup__pill" data-status="ready">{copy.customBadge}</span>
              ) : null}
            </div>
            <div className="guided-setup__team-actions">
              {api.syncModelCatalog ? (
                <button
                  type="button"
                  className="guided-setup__button"
                  disabled={busy !== null}
                  onClick={syncModels}
                >
                  {busy === 'models_sync' ? copy.syncingModels : copy.syncModels}
                </button>
              ) : null}
              {effectiveLineup.ready && Object.keys(effectiveLineup.roles).length > 0 ? (
                <button
                  type="button"
                  className="guided-setup__button"
                  aria-expanded={roleEditorOpen}
                  onClick={() => setRoleEditorOpen((open) => !open)}
                >
                  {roleEditorOpen ? copy.hideCustomizeRoles : copy.customizeRoles}
                </button>
              ) : null}
            </div>
          </div>
          {Object.keys(effectiveLineup.roles).length > 0 ? (
            <p className="guided-setup__lineup">{lineupSummary(effectiveLineup, locale, modelCatalog.models)}</p>
          ) : null}
          <p className="guided-setup__reason">{copy.modelsDailyHint}</p>
          {catalogFeedback ? <p className="guided-setup__done-note" role="status">{catalogFeedback}</p> : null}
          {!catalogFeedback && catalogSyncFailed ? (
            <p className="guided-setup__done-note" role="status">{copy.modelsSyncFailed}</p>
          ) : null}
          {effectiveLineup.ready && baselineLineup && selectableProviders.length > 1 ? (
            <div className="guided-setup__presets" role="group" aria-label={copy.customizeRoles}>
              <button
                type="button"
                className="guided-setup__chip"
                aria-pressed={!isCustomized}
                onClick={resetCustomization}
              >
                {copy.presetRecommended}
              </button>
              {selectableProviders.map((providerId) => {
                const uniform = Object.values(effectiveLineup.roles).every((assigned) => assigned === providerId);
                return (
                  <button
                    key={providerId}
                    type="button"
                    className="guided-setup__chip"
                    aria-pressed={uniform}
                    onClick={() => applyCustomLineup(assignAllRoles(baselineLineup, providerId, modelCatalog))}
                  >
                    {copy.presetAllProvider(formatProviderDisplay(providerId))}
                  </button>
                );
              })}
            </div>
          ) : null}
          {effectiveLineup.ready && baselineLineup && roleEditorOpen && Object.keys(effectiveLineup.roles).length > 0 ? (
            <div className="guided-setup__role-grid">
              {Object.entries(effectiveLineup.roles).map(([role, assignedProvider]) => {
                const tier = modelCatalog.role_tiers[role] ?? 'L2';
                const parsed = parseRoleSpec(effectiveLineup.model_overrides?.[role] ?? '', assignedProvider);
                const providerModels = modelsForProvider(modelCatalog.models, assignedProvider);
                const latestModels = providerModels.filter((m) => m.status === 'latest');
                // Legacy and synced models share one list ranked by version.
                const otherModels = providerModels.filter((m) => m.status !== 'latest');
                const selectedModel = parsed.model || providerModels[0]?.id || '';
                const tierEffort = tier === 'L0' || tier === 'L1' ? 'medium' : 'max';
                const effortFor = (modelId: string) => effortOptionsFor(
                  providerModels.find((m) => m.id === modelId), assignedProvider, modelCatalog.efforts,
                );
                const effortOptions = effortFor(selectedModel);
                const selectedEffort = coerceEffort(parsed.effort || tierEffort, effortOptions, tierEffort);
                const pickers = providerTemplateSupport(providerCommands[assignedProvider]);
                return (
                  <div key={role} className="guided-setup__role-row">
                    <div className="guided-setup__role-head">
                      <span className="guided-setup__tier" data-tier="official">{tier}</span>
                      <span className="guided-setup__role-label">{translateRole(role, locale)}</span>
                    </div>
                    <div className="guided-setup__role-controls">
                      <select
                        className="guided-setup__select"
                        aria-label={`${translateRole(role, locale)} · ${copy.providerColumnLabel}`}
                        value={assignedProvider}
                        onChange={(event) => applyCustomLineup(assignRoleProvider(effectiveLineup, role, event.currentTarget.value, modelCatalog))}
                      >
                        {selectableProviders.map((providerId) => (
                          <option key={providerId} value={providerId}>
                            {formatProviderDisplay(providerId)}
                          </option>
                        ))}
                      </select>
                      {pickers.model && providerModels.length > 0 ? (
                        <select
                          className="guided-setup__select guided-setup__select--model"
                          aria-label={`${translateRole(role, locale)} · ${copy.modelColumnLabel}`}
                          value={selectedModel}
                          onChange={(event) => applyCustomLineup(
                            assignRoleModelSpec(
                              effectiveLineup, role, assignedProvider, event.currentTarget.value,
                              coerceEffort(selectedEffort, effortFor(event.currentTarget.value), tierEffort),
                            ),
                          )}
                        >
                          {latestModels.length > 0 ? (
                            <optgroup label={copy.modelGroupLatest}>
                              {latestModels.map((entry) => (
                                <option key={entry.id} value={entry.id}>{entry.label}</option>
                              ))}
                            </optgroup>
                          ) : null}
                          {otherModels.length > 0 ? (
                            <optgroup label={copy.modelGroupLegacy}>
                              {otherModels.map((entry) => (
                                <option key={entry.id} value={entry.id}>{entry.label}</option>
                              ))}
                            </optgroup>
                          ) : null}
                        </select>
                      ) : null}
                      {pickers.effort ? (
                        <select
                          className="guided-setup__select guided-setup__select--effort"
                          aria-label={`${translateRole(role, locale)} · ${copy.effortColumnLabel}`}
                          value={selectedEffort}
                          onChange={(event) => applyCustomLineup(
                            assignRoleModelSpec(effectiveLineup, role, assignedProvider, selectedModel, event.currentTarget.value),
                          )}
                        >
                          {effortOptions.map((eff) => (
                            <option key={eff.id} value={eff.id}>{eff.label}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="guided-setup__effort-note">{copy.effortUnsupported}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
          {effectiveLineup.ready && baselineLineup && savedProfiles.length > 0 ? (
            <div className="guided-setup__saved-profiles" role="group" aria-label={copy.savedProfilesTitle}>
              <span className="guided-setup__saved-label">{copy.savedProfilesTitle}</span>
              {savedProfiles.map((profile) => (
                <span key={profile.id} className="guided-setup__profile-chip">
                  <button
                    type="button"
                    className="guided-setup__chip"
                    aria-pressed={matchedProfile?.id === profile.id}
                    disabled={busy !== null}
                    onClick={() => applyProfile(profile)}
                  >
                    {profile.name}
                  </button>
                  {api.deleteLineupProfile ? (
                    <button
                      type="button"
                      className="guided-setup__profile-delete"
                      aria-label={copy.deleteProfileAria(profile.name)}
                      disabled={busy !== null}
                      onClick={() => removeSavedProfile(profile.id)}
                    >
                      ×
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}
          {effectiveLineup.ready && api.saveLineupProfile ? (
            <form
              className="guided-setup__save-profile"
              onSubmit={(event) => {
                event.preventDefault();
                if (busy === null && profileNameInput.trim()) saveCurrentProfile();
              }}
            >
              <input
                className="guided-setup__input"
                aria-label={copy.saveProfileButton}
                placeholder={copy.saveProfilePlaceholder}
                value={profileNameInput}
                disabled={busy !== null}
                onChange={(event) => setProfileNameInput(event.currentTarget.value)}
              />
              <button
                type="submit"
                className="guided-setup__button"
                disabled={busy !== null || !profileNameInput.trim()}
              >
                {busy === 'save_profile' ? copy.savingProfile : copy.saveProfileButton}
              </button>
            </form>
          ) : null}
          {profileFeedback ? <p className="guided-setup__done-note" role="status">{profileFeedback}</p> : null}
          {effectiveLineup.ready ? (
            <div className="guided-setup__team-actions">
              <button
                type="button"
                className="guided-setup__button guided-setup__button--primary"
                disabled={busy !== null}
                onClick={handleConfirmLineup}
              >
                {isCustomized ? copy.useCustomLineup : copy.useLineup}
              </button>
              {isCustomized ? (
                <button
                  type="button"
                  className="guided-setup__button"
                  disabled={busy !== null}
                  onClick={resetCustomization}
                >
                  {copy.resetLineup}
                </button>
              ) : null}
            </div>
          ) : (
            <p className="guided-setup__next">{lineupNotes(effectiveLineup, locale)}</p>
          )}
          {pendingApiDrivers.length > 0 ? (
            <div className="guided-setup__api-hint" role="note">
              <span>
                {copy.teamNeedsApiKeyNote(
                  pendingApiDrivers.map(({ driver }) => driverDisplayName(driver)).join(locale === 'zh' ? '、' : ', '),
                  [...new Set(pendingApiDrivers.map(({ envKey }) => envKey))].join(locale === 'zh' ? '、' : ', '),
                )}
              </span>
              {api.listCredentials ? (
                <button
                  type="button"
                  className="guided-setup__button"
                  disabled={busy !== null}
                  onClick={() => openApiKeyEditor(pendingApiDrivers[0]?.envKey)}
                >
                  {copy.configureApiKeyAction}
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {error ? <p className="guided-setup__error" role="alert">{error}</p> : null}
    </div>
  );
}
