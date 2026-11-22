import type { DoctorRoleRequest, PresetItem, ProviderHealthSummary, RolesConfigResponse } from '../../types/graph';

export type ReadinessState = 'ready' | 'cooldown' | 'missing';

export type ProviderHealth = ProviderHealthSummary & {
  // The health endpoint reports Unix seconds.
  cooldown_until?: number;
};

export type ProviderHealthMap = ReadonlyMap<string, ProviderHealth>;

export type ModelPinFields = {
  pinned?: boolean;
  assigned_model?: string;
};

type ModelPinPatch =
  | { pinned: true; assigned_model: string }
  | { pinned: undefined; assigned_model: undefined };

export type DoctorTargets = Pick<RolesConfigResponse, 'providers' | 'roles'>;

export function getReadinessState(health: ProviderHealth | undefined, nowMs: number): ReadinessState {
  if ((health?.cooldown_until ?? 0) * 1000 > nowMs) return 'cooldown';
  if (health?.ok) return 'ready';
  if (health && /\b(?:429|cool[- ]?down|rate[- ]limit(?:ed)?)\b/i.test(health.detail)) return 'cooldown';
  return 'missing';
}

type PresetReadiness = Pick<PresetItem, 'required_providers' | 'missing_providers' | 'host_ready'>;

export function getPresetProviderHealth(presets: readonly PresetReadiness[]): ProviderHealthMap {
  const ready = new Set<string>();
  const missing = new Set<string>();

  for (const preset of presets) {
    if (preset.host_ready || preset.missing_providers !== undefined) {
      for (const provider of preset.required_providers ?? []) ready.add(provider);
    }
    for (const provider of preset.missing_providers ?? []) missing.add(provider);
  }

  const health = new Map<string, ProviderHealth>();
  for (const provider of ready) health.set(provider, { provider, ok: true, detail: '' });
  for (const provider of missing) health.set(provider, { provider, ok: false, detail: '' });
  return health;
}

export function resolveDoctorTarget(
  fields: DoctorRoleRequest & ModelPinFields,
  config?: DoctorTargets,
): { request: DoctorRoleRequest; provider?: string } {
  const provider = fields.provider?.trim() || undefined;
  const role = fields.role?.trim() || undefined;
  const assigned = fields.pinned ? fields.assigned_model?.trim() : undefined;
  const model = assigned || fields.model?.trim() || undefined;
  const separator = model?.indexOf(':') ?? -1;

  if (model && separator > 0 && (assigned || !provider)) {
    const prefix = model.slice(0, separator);
    if (prefix === provider || (config && Object.hasOwn(config.providers, prefix))) {
      return { request: { provider: prefix, role, model: model.slice(separator + 1) }, provider: prefix };
    }
  }

  const roleProvider = config && role && Object.hasOwn(config.roles, role) ? config.roles[role].provider : undefined;
  return { request: { provider, role, model }, provider: provider ?? roleProvider };
}

export function serializeModelPin(
  pinned: boolean,
  { provider, model }: Pick<DoctorRoleRequest, 'provider' | 'model'>,
): ModelPinPatch {
  const spec = model?.trim();
  if (!pinned || !spec) return { pinned: undefined, assigned_model: undefined };

  const prefix = provider?.trim();
  return {
    pinned: true,
    assigned_model: prefix && !spec.startsWith(`${prefix}:`) ? `${prefix}:${spec}` : spec,
  };
}
