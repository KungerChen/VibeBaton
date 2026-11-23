import type { WorkflowGraph } from '../../types/graph';

function slug(value: string): string {
  const words = value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu);
  return words?.join('-') ?? '';
}

export function recipeFileName(graph: WorkflowGraph): string {
  const name = slug(graph.name) || slug(graph.id) || 'recipe';
  return `${name}.baton.json`;
}

export function serializeRecipe(graph: WorkflowGraph): string {
  return JSON.stringify(graph, null, 2);
}

export function recipeStats(graph: WorkflowGraph): { name: string; nodeCount: number; edgeCount: number } {
  return { name: graph.name, nodeCount: graph.nodes.length, edgeCount: graph.edges.length };
}
