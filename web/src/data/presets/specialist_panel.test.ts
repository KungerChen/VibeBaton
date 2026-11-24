import { expect, test, vi } from 'vitest';
import { simulateGraph, validateGraph } from '../../engine/localSimulator';
import { SCENARIOS } from '../../types/graph';
import { specialist_panel } from './specialist_panel';

test('specialist_panel matches the repository preset', async () => {
  // The frontend dependencies omit @types/node, so type only the Node APIs used here.
  const { readFileSync } = await vi.importActual<{
    readFileSync(path: URL, encoding: 'utf8'): string;
  }>('node:fs');
  const { posix } = await vi.importActual<{
    posix: { join(...parts: string[]): string };
  }>('node:path');

  const path = posix.join('../../../../presets', 'specialist_panel.baton.json');
  const json: unknown = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

  expect(specialist_panel).toEqual(json);
});

test('specialist_panel validates as a panel preset with eight nodes', () => {
  const validation = validateGraph(specialist_panel);

  expect(validation).toMatchObject({ valid: true, errors: [], warnings: [] });
  expect(specialist_panel.category).toBe('panel');
  expect(specialist_panel.cost_tier).toBe('medium');
  expect(specialist_panel.nodes).toHaveLength(8);
});

test.each(SCENARIOS)('%s simulation succeeds', (scenario) => {
  expect(simulateGraph(specialist_panel, scenario).status).toBe('completed');
});
