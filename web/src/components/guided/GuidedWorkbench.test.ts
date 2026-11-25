import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { BatonApiClient } from '../../api/client';
import { MESSAGES } from '../../i18n/messages';
import type { LiveRunSnapshot } from '../../types/graph';
import {
  GUIDED_STEPS,
  GuidedWorkbench,
  nextStep,
  signOffSummaryFromSnapshot,
  stepFromRun,
  taskIdFromNodeId,
  waitingDecision,
} from './GuidedWorkbench';

function snapshot(run: Record<string, unknown> | null, extra: Partial<LiveRunSnapshot> = {}): LiveRunSnapshot {
  return { run, milestones: [], tasks: [], events: [], quotas: [], ...extra };
}

describe('nextStep', () => {
  test('walks setup -> brainstorm -> live -> signoff and stays on signoff', () => {
    expect(GUIDED_STEPS).toEqual(['setup', 'brainstorm', 'live', 'signoff']);
    expect(nextStep('setup')).toBe('brainstorm');
    expect(nextStep('brainstorm')).toBe('live');
    expect(nextStep('live')).toBe('signoff');
    expect(nextStep('signoff')).toBe('signoff');
  });
});

describe('stepFromRun', () => {
  test('returns null until the run reports a status', () => {
    expect(stepFromRun(undefined)).toBeNull();
    expect(stepFromRun(null)).toBeNull();
    expect(stepFromRun('')).toBeNull();
    expect(stepFromRun(42)).toBeNull();
  });

  test('final-gate and completed runs go to sign-off', () => {
    expect(stepFromRun('READY_FOR_FINAL_GATE')).toBe('signoff');
    expect(stepFromRun('COMPLETED')).toBe('signoff');
    expect(stepFromRun(' completed ')).toBe('signoff');
  });

  test('every other status stays on the live build view', () => {
    for (const status of ['PLANNING', 'RUNNING', 'WAITING_HUMAN', 'PAUSED', 'FAILED']) {
      expect(stepFromRun(status), status).toBe('live');
    }
  });
});

describe('taskIdFromNodeId', () => {
  test('maps live task nodes to task ids and ignores other nodes', () => {
    expect(taskIdFromNodeId('live-task-M1-T2')).toBe('M1-T2');
    expect(taskIdFromNodeId('live-task-')).toBeNull();
    expect(taskIdFromNodeId('live-ms-M1')).toBeNull();
    expect(taskIdFromNodeId('live-planner')).toBeNull();
  });
});

describe('waitingDecision', () => {
  const attention = {
    id: 7,
    kind: 'human_attention_required',
    task_id: 'M1-T1',
    message: 'Merge conflict needs a call',
    payload_json: JSON.stringify({ category: 'waiting_human' }),
  };

  test('is null unless the run is WAITING_HUMAN', () => {
    expect(waitingDecision(null)).toBeNull();
    expect(waitingDecision(snapshot({ id: 'r1', status: 'RUNNING' }, { events: [attention] }))).toBeNull();
  });

  test('reads the task and question from the latest waiting_human event', () => {
    const decision = waitingDecision(snapshot(
      { id: 'r1', status: 'WAITING_HUMAN', human_prompt: 'Approve the conflicting change?' },
      { events: [attention] },
    ));
    expect(decision).toMatchObject({ taskId: 'M1-T1', question: 'Approve the conflicting change?', key: 'r1|M1-T1|7' });
    expect(decision?.options.map(({ id }) => id)).toEqual(['approve', 'reject']);
  });

  test('falls back to a WAITING_HUMAN task and returns null without any task id', () => {
    const run = { id: 'r1', status: 'WAITING_HUMAN', updated_at: 5 };
    expect(waitingDecision(snapshot(run, { tasks: [{ id: 'M1-T3', status: 'WAITING_HUMAN' }] }))?.taskId).toBe('M1-T3');
    expect(waitingDecision(snapshot(run))).toBeNull();
  });

  test('ignores stale waiting_human events older than the latest human_decision', () => {
    const stale = {
      id: 3,
      kind: 'human_attention_required',
      task_id: 'M1-T1',
      message: 'Old question',
      payload_json: JSON.stringify({ category: 'waiting_human' }),
    };
    const resolved = { id: 4, kind: 'human_decision', task_id: 'M1-T1', message: 'Resolved' };
    const decision = waitingDecision(snapshot(
      { id: 'r1', status: 'WAITING_HUMAN', human_prompt: 'New milestone issue' },
      {
        tasks: [{ id: 'M1-T2', status: 'WAITING_HUMAN' }],
        events: [stale, resolved],
      },
    ));
    expect(decision?.taskId).toBe('M1-T2');
    expect(decision?.question).toBe('New milestone issue');
  });
});

describe('signOffSummaryFromSnapshot', () => {
  test('counts passed tasks and unions changed files from task events', () => {
    const summary = signOffSummaryFromSnapshot(snapshot({ id: 'r1', status: 'READY_FOR_FINAL_GATE' }, {
      tasks: [{ id: 'a', status: 'PASSED' }, { id: 'b', status: 'PASSED' }, { id: 'c', status: 'FAILED' }],
      events: [
        { kind: 'task_passed', payload_json: JSON.stringify({ changed_files: ['a.ts', 'b.ts'] }) },
        { kind: 'task_passed', payload: { changed_files: ['b.ts', 'c.ts'] } },
        { kind: 'note', payload_json: 'not json' },
      ],
    }));
    expect(summary).toEqual({ testsPassed: 2, testsTotal: 3, changedFiles: ['a.ts', 'b.ts', 'c.ts'], reportUrl: '' });
  });
});

describe('GuidedWorkbench', () => {
  test('starts on the workspace step with all four step titles in the rail', () => {
    for (const locale of ['en', 'zh'] as const) {
      const html = renderToStaticMarkup(createElement(GuidedWorkbench, {
        locale,
        client: {} as BatonApiClient,
        liveSnapshot: null,
        onFollowRun: () => {},
      }));
      for (const { title } of MESSAGES[locale].guided.steps) expect(html).toContain(title);
      expect(html).toContain('data-step="setup"');
      expect(html).toContain('aria-current="step"');
    }
  });
});
