import { expect, test } from 'vitest';
import { flagship_4tier } from '../data/presets/flagship_4tier';
import type { NodeType, TierKey } from './graph';
import { tierForNodeType } from './graph';

test('the flagship nodes use the tiers of their configured roles', () => {
  const tiers = flagship_4tier.nodes.map(({ id, type, role }) => [id, tierForNodeType(type, role)]);
  expect(Object.fromEntries(tiers)).toEqual({
    l0_brainstorm: 'L0',
    l1_plan: 'L1',
    router_tier: 'ROUTER',
    l2_specialist: 'L2',
    l3_bulk: 'L3',
    gate_unit: 'GATE',
    l2_review: 'L2',
    git_merge: 'MERGE',
    l1_milestone_review: 'L1',
    l0_final_gate: 'L0',
  });
});

test.each<[NodeType, TierKey]>([
  ['planner_node', 'L1'],
  ['router_node', 'ROUTER'],
  ['worker_node', 'L2'],
  ['gate_node', 'GATE'],
  ['reviewer_node', 'L1'],
  ['merge_node', 'MERGE'],
  ['human_gate_node', 'HUMAN'],
])('%s uses its type tier when the role is absent or unrecognized', (type, tier) => {
  expect(tierForNodeType(type)).toBe(tier);
  expect(tierForNodeType(type, 'custom_role')).toBe(tier);
});
