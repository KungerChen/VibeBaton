import { DEMO_ROLES_CONFIG, demoProviderHealth } from '../data/demoConfig';
import { PRESET_REGISTRY, findPreset, presetToItem } from '../data/presets';
import { simulateGraph, validateGraph } from '../engine/localSimulator';
import type {
  BudgetConfigResponse,
  BudgetProfile,
  CredentialStatus,
  DoctorRoleRequest,
  DoctorRoleResult,
  GraphValidationResult,
  LiveRunSnapshot,
  PresetItem,
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

type RunDecision = 'approve' | 'reject';

const DEMO_DOCTOR_LATENCY_MS = 5000;
const CREDENTIAL_KEYS = ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'OPENCODE_API_KEY', 'ANTHROPIC_API_KEY'] as const;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class BatonApiClient {
  mode: ApiMode = 'demo';
  health: Record<string, unknown> | null = null;
  private readonly baseUrl: string;
  private demoBudgetProfile: BudgetProfile = 'balanced';
  private readonly demoCredentials = new Map<string, string>();

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
