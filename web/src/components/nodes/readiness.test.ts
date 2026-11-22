import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { BatonApiClient } from '../../api/client';
import { probeDoctorRole } from '../inspector/GraphEditor';
import { BatonNode, type BatonFlowNode } from './BatonNode';
import {
  getPresetProviderHealth,
  getReadinessState,
  resolveDoctorTarget,
  serializeModelPin,
  type DoctorTargets,
  type ProviderHealth,
  type ReadinessState,
} from './readiness';

const NOW = 10_000;
const HEALTHY: ProviderHealth = { provider: 'codex_sub', ok: true, detail: 'CLI is ready.' };

const WORKER: Omit<NodeProps<BatonFlowNode>, 'data'> = {
  id: 'build',
  type: 'baton',
  dragging: false,
  zIndex: 0,
  selectable: true,
  deletable: true,
  selected: false,
  draggable: true,
  isConnectable: true,
  positionAbsoluteX: 0,
  positionAbsoluteY: 0,
};

describe('Provider readiness', () => {
  test.each<readonly [string, ProviderHealth | undefined, ReadinessState]>([
    ['successful check', HEALTHY, 'ready'],
    ['active quota window', { ...HEALTHY, cooldown_until: 11 }, 'cooldown'],
    ['expired quota window', { ...HEALTHY, cooldown_until: 10 }, 'ready'],
    ['rate-limited check', { ...HEALTHY, ok: false, detail: 'Rate limit reached.' }, 'cooldown'],
    ['failed check', { ...HEALTHY, ok: false, install_hint: 'Run codex login.' }, 'missing'],
    ['unreported provider', undefined, 'missing'],
  ])('maps %s to its dot state', (_label, health, expected) => {
    expect(getReadinessState(health, NOW)).toBe(expected);
  });

  test('seeds providers with known results from the preset catalog', () => {
    const health = getPresetProviderHealth([
      { host_ready: true, required_providers: ['codex_sub', 'claude_sub'] },
      { host_ready: false, required_providers: ['claude_sub', 'dsh_opencode'], missing_providers: ['claude_sub'] },
      { host_ready: false, required_providers: ['unreported'] },
    ]);

    expect(health.size).toBe(3);
    expect(getReadinessState(health.get('codex_sub'), NOW)).toBe('ready');
    expect(getReadinessState(health.get('dsh_opencode'), NOW)).toBe('ready');
    expect(getReadinessState(health.get('claude_sub'), NOW)).toBe('missing');
    expect(health.has('unreported')).toBe(false);
  });

  test.each([
    [HEALTHY, 'ready', 'Ready'],
    [{ ...HEALTHY, cooldown_until: 11 }, 'cooldown', 'Cooldown'],
    [{ ...HEALTHY, ok: false }, 'missing', 'Missing'],
  ] as const)('renders the accessible dot for %j', (health, state, label) => {
    const node = createElement(BatonNode, {
      ...WORKER,
      data: {
        nodeType: 'worker_node',
        label: 'Build',
        provider: health.provider,
        state: 'idle',
        providerHealth: new Map([[health.provider, health]]),
        readinessTime: NOW,
      },
    });
    const markup = renderToStaticMarkup(createElement(ReactFlowProvider, null, node));

    expect(markup).toContain(`baton-node__readiness--${state}" role="img" aria-label="${label}"`);
  });
});

describe('Model override', () => {
  const config: DoctorTargets = {
    providers: { codex_sub: { max_concurrency: 1, command: ['codex'] } },
    roles: { bulk_worker: { provider: 'dsh_opencode', model: 'default', fallback: [] } },
  };

  test('probes the pinned provider and model following an import', () => {
    const { request } = resolveDoctorTarget({
      role: 'bulk_worker',
      provider: 'dsh_opencode',
      model: 'default',
      pinned: true,
      assigned_model: 'codex_sub:gpt-6.2-sol@max',
    }, config);

    expect(request).toStrictEqual({
      role: 'bulk_worker',
      provider: 'codex_sub',
      model: 'gpt-6.2-sol@max',
    });
  });

  test('resolves role-only and provider-qualified targets', () => {
    const role = resolveDoctorTarget({ role: 'bulk_worker' }, config);
    const qualified = resolveDoctorTarget({ role: 'bulk_worker', model: 'codex_sub:gpt-6.2-sol' }, config);

    expect(role.provider).toBe('dsh_opencode');
    expect(role.request).toMatchObject({ role: 'bulk_worker', provider: undefined });
    expect(qualified.request).toMatchObject({ provider: 'codex_sub', model: 'gpt-6.2-sol' });
  });

  test.each([
    [{ provider: 'codex_sub', model: ' gpt-6.2-sol@max ' }, 'codex_sub:gpt-6.2-sol@max'],
    [{ provider: 'codex_sub', model: 'codex_sub:gpt-6.2-sol@max' }, 'codex_sub:gpt-6.2-sol@max'],
    [{ model: 'deepseek-v4.1-flash@low' }, 'deepseek-v4.1-flash@low'],
  ] as const)('serializes %o as a PlanDAG model spec', (target, assignedModel) => {
    expect(serializeModelPin(true, target)).toStrictEqual({ pinned: true, assigned_model: assignedModel });
  });

  test.each([
    [false, 'gpt-6.2-sol'],
    [true, '  '],
  ] as const)('clears the pin with enabled=%s and model=%j', (enabled, model) => {
    expect(serializeModelPin(enabled, { model })).toStrictEqual({ pinned: undefined, assigned_model: undefined });
  });
});

describe('Doctor deadline', () => {
  afterEach(() => vi.useRealTimers());

  test('releases a suspended probe at five seconds', async () => {
    vi.useFakeTimers();
    const request = { provider: 'codex_sub', role: 'critical_executor', model: 'gpt-6.2-sol@max' };
    const doctorRole = vi.fn<BatonApiClient['doctorRole']>(() => new Promise(() => {}));
    const settled = vi.fn();
    const probe = probeDoctorRole({ doctorRole }, request).then(settled);

    expect(doctorRole).toHaveBeenCalledExactlyOnceWith(request);
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await probe;
    expect(settled).toHaveBeenCalledExactlyOnceWith(null);
  });

  test('returns the demo response when its own five-second timer completes', async () => {
    vi.useFakeTimers();
    const probe = probeDoctorRole(new BatonApiClient(), { provider: 'host_native' });

    await vi.advanceTimersByTimeAsync(5000);

    await expect(probe).resolves.toMatchObject({ provider: 'host_native', ok: true, latency_ms: 5000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  test('clears the deadline on a request error', async () => {
    vi.useFakeTimers();
    const doctorRole = vi.fn<BatonApiClient['doctorRole']>().mockRejectedValue(new Error('Unavailable'));

    await expect(probeDoctorRole({ doctorRole }, { provider: 'codex_sub' })).rejects.toThrow('Unavailable');
    expect(vi.getTimerCount()).toBe(0);
  });
});
