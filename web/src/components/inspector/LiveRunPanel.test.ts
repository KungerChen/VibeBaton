import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { BatonApiClient } from '../../api/client';
import type { LiveRunSnapshot, RunAttentionState } from '../../types/graph';
import { LiveRunPanel } from './LiveRunPanel';

test.each([
  { status: 'GATE_CHECKING', startedAt: null, afterTick: '1m 30s' },
  { status: 'COOLDOWN', startedAt: null, afterTick: '1m 30s' },
  { status: 'RUNNING', startedAt: 112, afterTick: '1m 33s' },
])('renders the $status task duration from the snapshot and its in-flight timing', ({ status, startedAt, afterTick }) => {
  const snapshot: LiveRunSnapshot = {
    run: { id: 'run-active', status: 'RUNNING' },
    milestones: [],
    tasks: [{ id: 'T1', title: 'Build client', status }],
    events: [],
    quotas: [],
    telemetry: {
      elapsed_sec: 100,
      server_now: 120,
      stages: [],
      models: [],
      task_timings: { T1: { duration_sec: 90, started_at: startedAt, is_active: true } },
    },
  };
  const client = new BatonApiClient();

  function renderTaskHeader(liveNowSec: number) {
    const panel = renderToStaticMarkup(createElement(LiveRunPanel, {
      client,
      visible: true,
      liveSnapshot: snapshot,
      liveNowSec,
      onSelectRunId: () => {},
      onToast: () => {},
    }));
    return panel.match(/<button\b[^>]*aria-expanded="false"[^>]*>.*?<\/button>/s)?.[0];
  }

  expect(renderTaskHeader(120)).toContain('>1m 30s</span>');
  expect(renderTaskHeader(123)).toContain(`>${afterTick}</span>`);
});

test('renders a telemetry attention line above the task accordion when present', () => {
  const attention: RunAttentionState = {
    category: 'long_cooldown',
    severity: 'warning',
    title: 'Provider quota cooldown',
    message: 'Provider quota recovers in five minutes.',
    action_hint: 'The run retries automatically.',
    milestone_id: 'M1',
    task_id: 'T1',
    created_at: 120,
  };
  const client = new BatonApiClient();

  function renderPanel(runAttention: RunAttentionState | null) {
    const liveSnapshot: LiveRunSnapshot = {
      run: { id: 'run-active', status: 'RUNNING' },
      milestones: [],
      tasks: [{ id: 'T1', title: 'Build client', status: 'COOLDOWN' }],
      events: [],
      quotas: [],
      telemetry: { elapsed_sec: 120, stages: [], models: [], attention: runAttention },
    };
    return renderToStaticMarkup(createElement(LiveRunPanel, {
      client,
      visible: true,
      liveSnapshot,
      onSelectRunId: () => {},
      onToast: () => {},
    }));
  }

  const panel = renderPanel(attention);
  expect(panel).toMatch(/<p[^>]*>.*?Provider quota recovers in five minutes\.<\/p>.*?class="task-accordion/s);
  expect(panel).toContain('aria-expanded="false"');
  expect(renderPanel(null)).not.toContain(attention.message);
});
