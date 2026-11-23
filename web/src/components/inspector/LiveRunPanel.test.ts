import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { BatonApiClient } from '../../api/client';
import type { LiveRunSnapshot } from '../../types/graph';
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
