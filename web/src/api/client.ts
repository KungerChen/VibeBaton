import { EMBEDDED_PRESETS, findPreset, presetToItem } from '../data/presets';
import { simulateGraph, validateGraph } from '../engine/localSimulator';
import type {
  GraphValidationResult,
  LiveRunSnapshot,
  PresetItem,
  RoleConfig,
  RolesConfigResponse,
  Scenario,
  SimulationResult,
  WorkflowGraph,
} from '../types/graph';

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
    if (this.mode === 'demo') return EMBEDDED_PRESETS.map(presetToItem);
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
    if (this.mode === 'demo') return null;
    const config = await this.requestJson<WireRolesConfigResponse>('/api/config/roles');
    return {
      ...config,
      roles: Object.fromEntries(Object.entries(config.roles).map(([name, role]) => [name, toRoleConfig(role)])),
    };
  }

  async updateRole(role: string, payload: { provider?: string; model: string }): Promise<RoleConfig> {
    const { role: updated } = await this.requestJson<{ role: WireRoleConfig }>(
      `/api/config/roles/${encodeURIComponent(role)}`,
      { method: 'PUT', body: payload },
    );
    return toRoleConfig(updated);
  }

  async getLatestRun(): Promise<LiveRunSnapshot> {
    if (this.mode === 'demo') return { run: null, milestones: [], tasks: [], events: [], quotas: [] };
    return this.requestJson('/api/runs/latest');
  }

  getRun(id: string): Promise<LiveRunSnapshot> {
    return this.requestJson(`/api/runs/${encodeURIComponent(id)}`);
  }

  async getRunReport(id: string): Promise<string> {
    const { battle_report_markdown } = await this.requestJson<{ battle_report_markdown: string }>(
      `/api/runs/${encodeURIComponent(id)}/report`,
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
