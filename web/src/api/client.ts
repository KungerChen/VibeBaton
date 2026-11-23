import { DEMO_ROLES_CONFIG, demoProviderHealth } from '../data/demoConfig';
import { PRESET_REGISTRY, findPreset, presetToItem } from '../data/presets';
import { buildOfficialStage1Case, parseAndValidateCaseBundle } from '../engine/caseReplay';
import { simulateGraph, validateGraph } from '../engine/localSimulator';
import type {
  BatonCaseBundle,
  BudgetConfigResponse,
  BudgetProfile,
  CredentialStatus,
  CustomPricingUpdate,
  DoctorRoleRequest,
  DoctorRoleResult,
  GraphValidationResult,
  LiveRunSnapshot,
  PresetItem,
  PricingCacheStatus,
  PricingModelEntry,
  PricingStatusResponse,
  PricingSyncResponse,
  RfcBrainstormRequest,
  RfcBrainstormResult,
  RfcReadinessResult,
  RoleConfig,
  RolesConfigResponse,
  RunListItem,
  Scenario,
  SimulationResult,
  WorkflowGraph,
} from '../types/graph';
import { checkRfcReadiness, generateStructuredRfc } from './offlineRfc';

export type ApiMode = 'local' | 'demo';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

type WireRoleConfig = Omit<RoleConfig, 'fallback'> & {
  fallback: (string | { provider: string; model: string })[];
};

type WireRolesConfigResponse = Omit<RolesConfigResponse, 'roles'> & {
  roles: Record<string, WireRoleConfig>;
};

type WirePricingStatusResponse = Omit<PricingStatusResponse, 'cache'> & {
  cache: PricingCacheStatus | (Omit<PricingCacheStatus, 'fetched_at'> & { fetched_at: number });
};

type WirePricingSyncResponse = Omit<PricingSyncResponse, 'catalog'> & {
  catalog: WirePricingStatusResponse;
};

type RunDecision = 'approve' | 'reject';

const DEMO_DOCTOR_LATENCY_MS = 5000;
const CREDENTIAL_KEYS = ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'OPENCODE_API_KEY', 'ANTHROPIC_API_KEY'] as const;

// Representative rows from the server's built-in catalog.
const DEMO_PRICING: PricingStatusResponse = {
  models: [
    { model: 'claude-sonnet-4-6', input_per_1m: 3, output_per_1m: 15, cached_input_per_1m: 0.3, source: 'builtin' },
    { model: 'deepseek-flash', input_per_1m: 0.3, output_per_1m: 1.2, cached_input_per_1m: 0.006, source: 'builtin' },
    { model: 'gpt-4o', input_per_1m: 2.5, output_per_1m: 10, cached_input_per_1m: 1.25, source: 'builtin' },
  ],
  cache: {
    path: '',
    fetched_at: null,
    age_sec: null,
    stale: true,
    refresh_interval_hours: 24,
    auto_sync: false,
    source_url: '',
  },
  custom_path: '',
};

function maskCredential(value: string): string {
  const characters = Array.from(value);
  const masked = characters.length <= 8
    ? '••••'
    : `${characters.slice(0, 4).join('')}••••${characters.slice(-4).join('')}`;
  return masked.includes(value) ? '****' : masked;
}

function toRoleConfig(role: WireRoleConfig): RoleConfig {
  return {
    ...role,
    fallback: role.fallback.map((target) =>
      typeof target === 'string' ? target : `${target.provider}:${target.model}`,
    ),
  };
}

function toPricingStatus({ cache, ...catalog }: WirePricingStatusResponse): PricingStatusResponse {
  const fetchedAt = cache.fetched_at;
  // The M2 API reports Unix seconds. Studio consumes an ISO timestamp.
  return {
    ...catalog,
    cache: { ...cache, fetched_at: typeof fetchedAt === 'number' ? new Date(fetchedAt * 1000).toJSON() : fetchedAt },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class BatonApiClient {
  mode: ApiMode = 'demo';
  health: Record<string, unknown> | null = null;
  private readonly baseUrl: string;
  private demoBudgetProfile: BudgetProfile = 'balanced';
  private readonly demoCredentials = new Map<string, string>();
  private demoCustomPricing = new Map<string, PricingModelEntry>();

  constructor(
    baseUrl = '',
    private readonly fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async init(): Promise<ApiMode> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const controller = new AbortController();
      const deadline = new Promise<null>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, 1500);
      });
      this.health = await Promise.race([this.probeHealth(controller.signal), deadline]);
    } catch {
      this.health = null;
    } finally {
      clearTimeout(timeout);
    }
    this.mode = this.health === null ? 'demo' : 'local';
    return this.mode;
  }

  async listPresets(): Promise<PresetItem[]> {
    if (this.mode === 'demo') {
      return PRESET_REGISTRY.map((graph) => {
        const requiredProviders = [...(graph.required_providers ?? [])];
        const missingProviders = requiredProviders.filter((provider) => !demoProviderHealth(provider).ok);
        return {
          ...presetToItem(graph),
          category: graph.category ?? 'general',
          required_providers: requiredProviders,
          cost_tier: graph.cost_tier ?? 'medium',
          inspired_by: graph.inspired_by ?? null,
          host_ready: missingProviders.length === 0,
          missing_providers: missingProviders,
        };
      });
    }
    const { presets } = await this.requestJson<{ presets: PresetItem[] }>('/api/presets');
    return presets;
  }

  async getPreset(id: string): Promise<WorkflowGraph> {
    if (this.mode === 'demo') {
      const preset = findPreset(id);
      if (!preset) throw new ApiError(404, `Unknown preset ID '${id}'`);
      return preset;
    }
    const { graph } = await this.requestJson<{ graph: WorkflowGraph }>(`/api/presets/${encodeURIComponent(id)}`);
    return graph;
  }

  async validate(graph: WorkflowGraph): Promise<GraphValidationResult> {
    if (this.mode === 'demo') return validateGraph(graph);
    return this.requestJson('/api/graph/validate', { method: 'POST', body: { graph } });
  }

  async simulate(graph: WorkflowGraph, scenario: Scenario): Promise<SimulationResult> {
    if (this.mode === 'demo') return simulateGraph(graph, scenario);
    return this.requestJson('/api/graph/simulate', { method: 'POST', body: { graph, scenario } });
  }

  async getRoles(): Promise<RolesConfigResponse | null> {
    return this.mode === 'demo' ? null : this.getRolesConfig();
  }

  async getRolesConfig(): Promise<RolesConfigResponse> {
    if (this.mode === 'demo') {
      return { ...structuredClone(DEMO_ROLES_CONFIG), budget_profile: this.demoBudgetProfile };
    }
    const config = await this.requestJson<WireRolesConfigResponse>('/api/config/roles');
    return {
      ...config,
      roles: Object.fromEntries(Object.entries(config.roles).map(([name, role]) => [name, toRoleConfig(role)])),
    };
  }

  async setBudgetProfile(profile: BudgetProfile): Promise<BudgetConfigResponse> {
    if (this.mode === 'local') {
      return this.requestJson('/api/config/budget', { method: 'PUT', body: { budget_profile: profile } });
    }
    this.demoBudgetProfile = profile;
    return { budget_profile: profile, model_catalog: structuredClone(DEMO_ROLES_CONFIG.model_catalog) };
  }

  async getPricing(): Promise<PricingStatusResponse> {
    if (this.mode === 'local') {
      return toPricingStatus(await this.requestJson<WirePricingStatusResponse>('/api/pricing'));
    }

    const models = [
      ...DEMO_PRICING.models.filter(({ model }) => !this.demoCustomPricing.has(model)),
      ...this.demoCustomPricing.values(),
    ].sort((left, right) => left.model.localeCompare(right.model));
    return structuredClone({ ...DEMO_PRICING, models });
  }

  async syncPricing(force = false): Promise<PricingSyncResponse> {
    if (this.mode === 'local') {
      const result = await this.requestJson<WirePricingSyncResponse>('/api/pricing/sync', {
        method: 'POST', body: { force },
      });
      return { ...result, catalog: toPricingStatus(result.catalog) };
    }

    const catalog = await this.getPricing();
    return { ok: true, fetched: false, skipped_fresh: true, model_count: catalog.models.length, error: null, catalog };
  }

  async saveCustomPricing(updates: CustomPricingUpdate): Promise<PricingStatusResponse> {
    if (this.mode === 'local') {
      const catalog = await this.requestJson<WirePricingStatusResponse>('/api/pricing/custom', {
        method: 'PUT', body: { updates },
      });
      return toPricingStatus(catalog);
    }

    const custom = new Map(this.demoCustomPricing);
    for (const [name, rates] of Object.entries(updates)) {
      const model = name.trim();
      if (!model) throw new ApiError(400, 'Custom pricing requires a non-empty model name.');
      if (rates === null) {
        custom.delete(model);
        continue;
      }

      const { input_per_1m, output_per_1m, cached_input_per_1m } = rates;
      if ([input_per_1m, output_per_1m, cached_input_per_1m].some((rate) => !Number.isFinite(rate) || rate < 0)) {
        throw new ApiError(400, `Invalid custom rates for '${model}'. Expected finite non-negative token rates.`);
      }
      custom.set(model, { model, input_per_1m, output_per_1m, cached_input_per_1m, source: 'custom' });
    }
    this.demoCustomPricing = custom;
    return this.getPricing();
  }

  async doctorRole(payload: DoctorRoleRequest): Promise<DoctorRoleResult> {
    if (this.mode === 'local') {
      return this.requestJson('/api/doctor/role', { method: 'POST', body: payload });
    }

    const roleName = payload.role?.trim() ?? '';
    const roleProvider = Object.hasOwn(DEMO_ROLES_CONFIG.roles, roleName)
      ? DEMO_ROLES_CONFIG.roles[roleName].provider
      : '';
    const prefix = payload.model?.trim().match(/^([^:]+):/)?.[1] ?? '';
    const modelProvider = roleProvider && Object.hasOwn(DEMO_ROLES_CONFIG.providers, prefix) ? prefix : '';
    const provider = payload.provider?.trim() || modelProvider || roleProvider;
    await new Promise<void>((resolve) => setTimeout(resolve, DEMO_DOCTOR_LATENCY_MS));
    return { ...demoProviderHealth(provider), latency_ms: DEMO_DOCTOR_LATENCY_MS };
  }

  async listCredentials(): Promise<CredentialStatus[]> {
    if (this.mode === 'local') return this.requestJson('/api/credentials');
    return CREDENTIAL_KEYS.map((key) => {
      const masked = this.demoCredentials.get(key);
      return {
        provider_key: key,
        configured: masked !== undefined,
        // Match the server's saved-credential status for the UI preview.
        source: masked === undefined ? 'none' : 'local_file',
        masked: masked ?? '',
      };
    });
  }

  async saveCredentials(updates: Record<string, string>): Promise<CredentialStatus[]> {
    if (this.mode === 'local') {
      return this.requestJson('/api/credentials', { method: 'POST', body: { updates } });
    }
    for (const key of CREDENTIAL_KEYS) {
      const value = updates[key];
      if (typeof value !== 'string' || value.includes('\0')) continue;
      if (value) this.demoCredentials.set(key, maskCredential(value));
      else this.demoCredentials.delete(key);
    }
    return this.listCredentials();
  }

  async checkRfc(rfcMarkdown: string): Promise<RfcReadinessResult> {
    if (this.mode === 'demo') return checkRfcReadiness(rfcMarkdown);
    return this.requestJson('/api/rfc/check', { method: 'POST', body: { rfc_markdown: rfcMarkdown } });
  }

  async brainstormRfc(payload: RfcBrainstormRequest): Promise<RfcBrainstormResult> {
    if (this.mode === 'demo') return generateStructuredRfc(payload);
    return this.requestJson('/api/rfc/brainstorm', { method: 'POST', body: payload });
  }

  async updateRole(role: string, payload: { provider?: string; model: string }): Promise<RoleConfig> {
    const { role: updated } = await this.requestJson<{ role: WireRoleConfig }>(
      `/api/config/roles/${encodeURIComponent(role)}`,
      { method: 'PUT', body: payload },
    );
    return toRoleConfig(updated);
  }

  async listRuns(): Promise<RunListItem[]> {
    if (this.mode === 'demo') return [];
    const { runs } = await this.requestJson<{ runs: RunListItem[] }>('/api/runs');
    return runs;
  }

  async getLatestRun(): Promise<LiveRunSnapshot> {
    if (this.mode === 'demo') return { run: null, milestones: [], tasks: [], events: [], quotas: [], telemetry: null };
    return this.requestJson('/api/runs/latest');
  }

  getRun(id: string): Promise<LiveRunSnapshot> {
    return this.requestJson(`/api/runs/${encodeURIComponent(id)}`);
  }

  async getRunReport(id: string, lang?: 'en' | 'zh'): Promise<string> {
    const query = lang ? `?lang=${encodeURIComponent(lang)}` : '';
    const { battle_report_markdown } = await this.requestJson<{ battle_report_markdown: string }>(
      `/api/runs/${encodeURIComponent(id)}/report${query}`,
    );
    return battle_report_markdown;
  }

  async exportRunCase(
    runId: string,
    options: { title?: string; includeReviews?: boolean; anonymize?: boolean } = {},
  ): Promise<BatonCaseBundle> {
    let raw: unknown;
    if (this.mode === 'demo') {
      const bundle = buildOfficialStage1Case('en');
      raw = { ...bundle, title: options.title ?? bundle.title };
    } else {
      const query = new URLSearchParams();
      if (options.title !== undefined) query.set('title', options.title);
      query.set('include_reviews', options.includeReviews === false ? '0' : '1');
      query.set('anonymize', options.anonymize ? '1' : '0');
      raw = await this.requestJson<unknown>(`/api/runs/${encodeURIComponent(runId)}/case-export?${query}`);
    }

    const result = parseAndValidateCaseBundle(raw);
    if (!result.ok) throw new ApiError(502, result.errors.join(' '));
    return result.bundle;
  }

  startRun(payload: {
    rfc_path?: string;
    rfc_markdown?: string;
    mode?: 'overnight' | 'interactive';
    model_overrides?: Record<string, string>;
  }): Promise<{ run_id: string; daemon_pid: number; status: string }> {
    return this.requestJson('/api/runs/start', { method: 'POST', body: payload });
  }

  controlRun(id: string, action: 'pause' | 'resume'): Promise<{
    run_id: string;
    status: string;
    daemon_pid?: number;
  }> {
    return this.requestJson(`/api/runs/${encodeURIComponent(id)}/control`, { method: 'POST', body: { action } });
  }

  resolveRun(id: string, decision: RunDecision, note?: string): Promise<{
    run_id: string;
    decision: RunDecision;
    daemon_pid: number | null;
  }> {
    return this.requestJson(`/api/runs/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: { decision, note } });
  }

  streamUrl(): string {
    return `${this.baseUrl}/api/runs/stream`;
  }

  private async probeHealth(signal: AbortSignal): Promise<Record<string, unknown> | null> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/health`, { method: 'GET', signal });
    if (response.status !== 200) return null;
    const health: unknown = await response.json();
    return isRecord(health) && health.status === 'ok' ? health : null;
  }

  private async requestJson<T>(path: string, write?: { method: 'POST' | 'PUT'; body: object }): Promise<T> {
    if (this.mode === 'demo') throw new ApiError(0, 'Not available in standalone demo');

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, write ? {
      method: write.method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(write.body),
    } : { method: 'GET' });

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const message = isRecord(body) && typeof body.error === 'string'
        ? body.error
        : response.statusText || `HTTP ${response.status}`;
      throw new ApiError(response.status, message);
    }
    return response.json() as Promise<T>;
  }
}
