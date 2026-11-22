import { expect, test, vi } from 'vitest';
import { presetToItem, starter_2tier } from '../data/presets';
import type { GraphValidationResult, LiveRunSnapshot, SimulationResult } from '../types/graph';
import { ApiError, BatonApiClient } from './client';

const health = { status: 'ok', version: 'test' };

function healthyFetch() {
  return vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(health));
}

function jsonRequest(method: 'POST' | 'PUT', body: object): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// Golden example of probing a server and using its preset catalog.
test('probes the configured local server and loads its presets', async () => {
  const baseUrl = 'http://127.0.0.1:7860';
  const preset = presetToItem(starter_2tier);
  const fetchImpl = healthyFetch().mockResolvedValueOnce(Response.json({ presets: [preset] }));
  const client = new BatonApiClient(`${baseUrl}/`, fetchImpl);

  expect(client.mode).toBe('demo');
  expect(client.health).toBeNull();
  await expect(client.init()).resolves.toBe('local');
  expect(client.mode).toBe('local');
  expect(client.health).toEqual(health);
  await expect(client.listPresets()).resolves.toEqual([preset]);
  expect(client.streamUrl()).toBe(`${baseUrl}/api/runs/stream`);

  expect(fetchImpl.mock.calls).toEqual([
    [`${baseUrl}/api/health`, { method: 'GET', signal: expect.any(AbortSignal) }],
    [`${baseUrl}/api/presets`, { method: 'GET' }],
  ]);
});

test('serves presets and graph operations offline after a rejected probe', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Offline'));
  const client = new BatonApiClient('', fetchImpl);
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    await expect(client.init()).resolves.toBe('demo');
    expect(client.health).toBeNull();
    const presets = await client.listPresets();
    expect(presets.map(({ id }) => id)).toEqual([
      'flagship_4tier', 'solo_coder_3tier', 'starter_2tier', 'review_only_audit',
    ]);
    await expect(client.getPreset('starter_2tier')).resolves.toEqual(starter_2tier);
    await expect(client.getPreset('unknown')).rejects.toMatchObject({ name: 'ApiError', status: 404 });
    await expect(client.validate(starter_2tier)).resolves.toMatchObject({ valid: true, errors: [] });
    await expect(client.simulate(starter_2tier, 'gate_retry')).resolves.toMatchObject({
      status: 'completed', visited_nodes: ['plan', 'worker', 'gate', 'worker', 'gate', 'final'],
    });
    await expect(client.updateRole('bulk_worker', { model: 'example' })).rejects.toMatchObject({
      name: 'ApiError', status: 0, message: 'Not available in standalone demo',
    });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith('/api/health', {
      method: 'GET', signal: expect.any(AbortSignal),
    });
    expect(consoleError).not.toHaveBeenCalled();
  } finally {
    consoleError.mockRestore();
  }
});

test.each([
  ['a non-200 status', () => Response.json(health, { status: 201 })],
  ['an unhealthy response', () => Response.json({ status: 'unavailable' })],
  ['a null JSON body', () => Response.json(null)],
  ['invalid JSON', () => new Response('<html>Static site</html>')],
])('returns to demo on a later probe with %s', async (_, response) => {
  const client = new BatonApiClient('', healthyFetch().mockResolvedValueOnce(response()));

  await expect(client.init()).resolves.toBe('local');
  await expect(client.init()).resolves.toBe('demo');
  expect(client.mode).toBe('demo');
  expect(client.health).toBeNull();
});

test('aborts an unresponsive health probe at 1500 ms', async () => {
  vi.useFakeTimers();
  try {
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const client = new BatonApiClient('', fetchImpl);
    const probing = client.init();
    const signal = fetchImpl.mock.calls[0][1]?.signal;

    await vi.advanceTimersByTimeAsync(1499);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await expect(probing).resolves.toBe('demo');
    expect(client.health).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  [404, 'nope', () => Response.json({ error: 'nope' }, { status: 404 })],
  [503, 'Service Unavailable', () => new Response('Unavailable', { status: 503, statusText: 'Service Unavailable' })],
])('surfaces HTTP %i as ApiError with the message %s', async (status, message, response) => {
  const client = new BatonApiClient('', healthyFetch().mockResolvedValueOnce(response()));
  await client.init();

  const result = client.getPreset('missing');
  await expect(result).rejects.toBeInstanceOf(ApiError);
  await expect(result).rejects.toMatchObject({ status, message });
  expect(client.mode).toBe('local');
});

test('loads a preset and sends local graph operations as JSON', async () => {
  const graph = starter_2tier;
  const validation: GraphValidationResult = {
    valid: true, errors: [], warnings: [], entry_nodes: ['plan'], has_cycles: true,
  };
  const simulation: SimulationResult = { status: 'halted', visited_nodes: ['plan'], trace: [] };
  const fetchImpl = healthyFetch()
    .mockResolvedValueOnce(Response.json({ graph }))
    .mockResolvedValueOnce(Response.json(validation))
    .mockResolvedValueOnce(Response.json(simulation));
  const client = new BatonApiClient('', fetchImpl);
  await client.init();

  await expect(client.getPreset(graph.id)).resolves.toEqual(graph);
  await expect(client.validate(graph)).resolves.toEqual(validation);
  await expect(client.simulate(graph, 'happy_path')).resolves.toEqual(simulation);
  expect(fetchImpl.mock.calls.slice(1)).toEqual([
    [`/api/presets/${graph.id}`, { method: 'GET' }],
    ['/api/graph/validate', jsonRequest('POST', { graph })],
    ['/api/graph/simulate', jsonRequest('POST', { graph, scenario: 'happy_path' })],
  ]);
});

test('reads and updates roles with CLI-style fallback targets', async () => {
  const role = {
    provider: 'host_native', model: 'initial', fallback: [{ provider: 'codex_sub', model: 'backup' }],
  };
  const config = { config_path: '.baton/baton.toml', providers: {}, roles: { bulk_worker: role } };
  const payload = { model: 'updated' };
  const fetchImpl = healthyFetch()
    .mockResolvedValueOnce(Response.json(config))
    .mockResolvedValueOnce(Response.json({ role_name: 'bulk_worker', role: { ...role, ...payload } }));
  const client = new BatonApiClient('', fetchImpl);
  await client.init();

  const roleConfig = { ...role, fallback: ['codex_sub:backup'] };
  await expect(client.getRoles()).resolves.toEqual({ ...config, roles: { bulk_worker: roleConfig } });
  await expect(client.updateRole('bulk_worker', payload)).resolves.toEqual({ ...roleConfig, ...payload });
  expect(fetchImpl.mock.calls.slice(1)).toEqual([
    ['/api/config/roles', { method: 'GET' }],
    ['/api/config/roles/bulk_worker', jsonRequest('PUT', payload)],
  ]);
});

test('loads run data and submits run commands to the local server', async () => {
  const runId = 'run-1';
  const snapshot: LiveRunSnapshot = {
    run: { id: runId }, milestones: [], tasks: [], events: [], quotas: [],
  };
  const report = '# Battle report';
  const started = { run_id: runId, daemon_pid: 4242, status: 'STARTED' };
  const resumed = { run_id: runId, daemon_pid: 4243, status: 'RUNNING' };
  const rejected = { run_id: runId, decision: 'reject', daemon_pid: null };
  const fetchImpl = healthyFetch()
    .mockResolvedValueOnce(Response.json(snapshot))
    .mockResolvedValueOnce(Response.json(snapshot))
    .mockResolvedValueOnce(Response.json({ run_id: runId, battle_report_markdown: report }))
    .mockResolvedValueOnce(Response.json(started, { status: 201 }))
    .mockResolvedValueOnce(Response.json(resumed))
    .mockResolvedValueOnce(Response.json(rejected));
  const client = new BatonApiClient('', fetchImpl);
  await client.init();

  const payload = { rfc_markdown: '# RFC', mode: 'interactive', model_overrides: { bulk_worker: 'example' } } as const;
  await expect(client.getLatestRun()).resolves.toEqual(snapshot);
  await expect(client.getRun(runId)).resolves.toEqual(snapshot);
  await expect(client.getRunReport(runId)).resolves.toBe(report);
  await expect(client.startRun(payload)).resolves.toEqual(started);
  await expect(client.controlRun(runId, 'resume')).resolves.toEqual(resumed);
  await expect(client.resolveRun(runId, 'reject')).resolves.toEqual(rejected);
  expect(fetchImpl.mock.calls.slice(1)).toEqual([
    ['/api/runs/latest', { method: 'GET' }],
    [`/api/runs/${runId}`, { method: 'GET' }],
    [`/api/runs/${runId}/report`, { method: 'GET' }],
    ['/api/runs/start', jsonRequest('POST', payload)],
    [`/api/runs/${runId}/control`, jsonRequest('POST', { action: 'resume' })],
    [`/api/runs/${runId}/resolve`, jsonRequest('POST', { decision: 'reject' })],
  ]);
});

test('returns empty live data and rejects backend-only run operations in demo mode', async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const client = new BatonApiClient('', fetchImpl);

  await expect(client.getRoles()).resolves.toBeNull();
  await expect(client.getLatestRun()).resolves.toEqual({ run: null, milestones: [], tasks: [], events: [], quotas: [] });
  const backendOnly = [
    client.getRun('run-1'),
    client.getRunReport('run-1'),
    client.startRun({ rfc_path: 'RFC.md' }),
    client.controlRun('run-1', 'pause'),
    client.resolveRun('run-1', 'approve', 'Reviewed'),
  ];
  await Promise.all(backendOnly.map((result) => expect(result).rejects.toMatchObject({
    name: 'ApiError', status: 0, message: 'Not available in standalone demo',
  })));
  expect(fetchImpl).not.toHaveBeenCalled();
});
