import { describe, expect, test } from 'vitest';
import { deriveStates } from '../engine/playback';
import { flagship_4tier } from './presets/flagship_4tier';
import { getStage1ReplayTrace, STAGE1_REPLAY_META, STAGE1_REPLAY_TRACE } from './stage1Replay';

describe('STAGE1_REPLAY_TRACE', () => {
  test('references only valid flagship_4tier node and edge IDs in monotonic seq order', () => {
    const nodeIds = new Set(flagship_4tier.nodes.map(({ id }) => id));
    const edgeIds = new Set(flagship_4tier.edges.map(({ id }) => id));

    expect(STAGE1_REPLAY_META.runId).toBe('run-20261121-044454-3b1845');
    expect(STAGE1_REPLAY_TRACE.length).toBeGreaterThan(20);

    let prevSeq = 0;
    let prevTimestamp = -1;
    for (const event of STAGE1_REPLAY_TRACE) {
      expect(event.seq).toBe(prevSeq + 1);
      expect(event.timestamp).toBeGreaterThanOrEqual(prevTimestamp);
      prevSeq = event.seq;
      prevTimestamp = event.timestamp;

      if (event.node_id !== null) expect(nodeIds.has(event.node_id)).toBe(true);
      if (event.edge_id !== null) expect(edgeIds.has(event.edge_id)).toBe(true);
    }
  });

  test('passes final gate and traverses fail (e6), minor_fix (e8), and escalate (e9) paths', () => {
    const lastEvent = STAGE1_REPLAY_TRACE[STAGE1_REPLAY_TRACE.length - 1];
    const derived = deriveStates(flagship_4tier, STAGE1_REPLAY_TRACE, lastEvent.seq);

    expect(derived.nodeStates.l0_final_gate).toBe('passed');
    expect(derived.traversedEdgeIds.has('e6')).toBe(true);
    expect(derived.traversedEdgeIds.has('e8')).toBe(true);
    expect(derived.traversedEdgeIds.has('e9')).toBe(true);
  });

  test('provides aligned pure Chinese replay messages without altering graph structure', () => {
    const enTrace = getStage1ReplayTrace('en');
    const zhTrace = getStage1ReplayTrace('zh');

    expect(zhTrace).toHaveLength(enTrace.length);
    for (let i = 0; i < enTrace.length; i += 1) {
      expect(zhTrace[i].seq).toBe(enTrace[i].seq);
      expect(zhTrace[i].node_id).toBe(enTrace[i].node_id);
      expect(zhTrace[i].edge_id).toBe(enTrace[i].edge_id);
      expect(zhTrace[i].outcome).toBe(enTrace[i].outcome);
      expect(/[\u4e00-\u9fff]/.test(zhTrace[i].message)).toBe(true);
    }
  });
});
