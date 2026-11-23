import { createElement, type MouseEvent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { assert, describe, expect, test, vi } from 'vitest';
import { flagship_4tier } from '../../data/presets/flagship_4tier';
import { validateGraph } from '../../engine/localSimulator';
import { buildShareUrl, decodeRecipeHash } from '../../engine/shareUrl';
import { MESSAGES } from '../../i18n/messages';
import type { WorkflowGraph } from '../../types/graph';
import { Button } from '../ui/button';
import { ExportRecipeModal } from './ExportRecipeModal';
import { recipeFileName, recipeStats, serializeRecipe } from './exportRecipe';

vi.mock('../ui/button', { spy: true });

const graph: WorkflowGraph = { ...flagship_4tier, name: 'Research & Review / 配方' };

describe('recipe export', () => {
  test.each([
    ['  My Recipe / v2!  ', 'flagship_4tier', 'my-recipe-v2.baton.json'],
    ['运行 配方', 'flagship_4tier', '运行-配方.baton.json'],
    [' ! ', 'flagship_4tier', 'flagship-4tier.baton.json'],
    ['', ' ! ', 'recipe.baton.json'],
  ])('uses a slug for the recipe named %j', (name, id, fileName) => {
    expect(recipeFileName({ ...graph, name, id })).toBe(fileName);
  });

  test('preserves the legacy pretty JSON and round-trips a valid graph', () => {
    const json = serializeRecipe(graph);
    expect(json).toBe(JSON.stringify(graph, null, 2));

    const parsed: WorkflowGraph = JSON.parse(json);
    expect(parsed).toStrictEqual(graph);
    expect(validateGraph(parsed)).toMatchObject({ valid: true, errors: [] });
  });

  test('counts nodes and edges independently', () => {
    expect(recipeStats(graph)).toEqual({ name: graph.name, nodeCount: 10, edgeCount: 13 });
    expect(recipeStats({ ...graph, nodes: [], edges: [] })).toEqual({
      name: graph.name, nodeCount: 0, edgeCount: 0,
    });
  });

  test('copies the exact #recipe= URL returned by the supplied encoder', async () => {
    const href = 'https://example.test/VibeBaton/?view=demo#old';
    const encode = vi.fn((input: WorkflowGraph) => buildShareUrl(input, href));
    const writeText = vi.fn<Clipboard['writeText']>().mockResolvedValue(undefined);
    const onToast = vi.fn();
    const labels = MESSAGES.en.transfer.exportRecipeModal;
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    try {
      renderToStaticMarkup(createElement(ExportRecipeModal, {
        open: true,
        onClose: () => {},
        graph,
        liveViewActive: false,
        onSwitchToCaseExport: () => {},
        buildShareUrl: encode,
        onToast,
      }));

      // Run the rendered button's handler in Vitest's Node environment.
      const click = vi.mocked(Button).mock.calls.find(([props]) => props.children === labels.copyLink)?.[0].onClick;
      assert(click, 'Missing Copy Recipe Link button');
      expect(encode).not.toHaveBeenCalled();
      await click({} as MouseEvent<HTMLButtonElement>);

      const expected = buildShareUrl(graph, href);
      expect(encode.mock.calls).toEqual([[graph]]);
      expect(writeText.mock.calls).toEqual([[expected]]);
      expect(expected).toContain('#recipe=');
      expect(decodeRecipeHash(new URL(expected).hash)).toStrictEqual({ graph });
      expect(onToast).toHaveBeenCalledWith(labels.copied);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
