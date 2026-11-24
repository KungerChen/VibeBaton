import { validateGraph } from '../engine/localSimulator';
import type { PresetItem, WorkflowGraph } from '../types/graph';
import { claude_only_3tier } from './presets/claude_only_3tier';
import { codex_only_3tier } from './presets/codex_only_3tier';
import { deepseek_bulk_factory } from './presets/deepseek_bulk_factory';
import { flagship_4tier } from './presets/flagship_4tier';
import { review_only_audit } from './presets/review_only_audit';
import { solo_coder_3tier } from './presets/solo_coder_3tier';
import { specialist_panel } from './presets/specialist_panel';
import { starter_2tier } from './presets/starter_2tier';

export {
  flagship_4tier,
  solo_coder_3tier,
  starter_2tier,
  review_only_audit,
  claude_only_3tier,
  codex_only_3tier,
  deepseek_bulk_factory,
  specialist_panel,
};

// These four graphs have baseline simulator parity fixtures.
export const EMBEDDED_PRESETS: WorkflowGraph[] = [
  flagship_4tier,
  solo_coder_3tier,
  starter_2tier,
  review_only_audit,
];

export const PRESET_REGISTRY: readonly WorkflowGraph[] = [
  ...EMBEDDED_PRESETS,
  claude_only_3tier,
  codex_only_3tier,
  deepseek_bulk_factory,
  specialist_panel,
];

export function presetToItem(graph: WorkflowGraph): PresetItem {
  const { valid, errors, warnings } = validateGraph(graph);
  return {
    id: graph.id,
    name: graph.name,
    difficulty: graph.difficulty ?? 'pro',
    description: graph.description ?? '',
    recommended_for: graph.recommended_for ?? [],
    node_count: graph.nodes.length,
    edge_count: graph.edges.length,
    valid,
    errors,
    warnings,
    graph,
  };
}

export function findPreset(id: string): WorkflowGraph | undefined {
  return PRESET_REGISTRY.find((graph) => graph.id === id);
}
