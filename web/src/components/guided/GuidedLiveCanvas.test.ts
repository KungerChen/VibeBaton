import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { assert, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Edge } from '@xyflow/react';
import type { RunHandoff } from '../../api/client';
import { buildLiveRunGraph } from '../../engine/liveRunGraph';
import { MESSAGES } from '../../i18n/messages';
import type { LiveRunSnapshot } from '../../types/graph';
import type { CanvasWorkspaceProps } from '../CanvasWorkspace';
import type { BatonFlowNode } from '../nodes/BatonNode';

let canvas: CanvasWorkspaceProps | undefined;
vi.mock('../CanvasWorkspace', async (load) => ({
  ...await load<typeof import('../CanvasWorkspace')>(),
  CanvasWorkspace: (props: CanvasWorkspaceProps) => { canvas = props; return null; },
}));

const { canvasEditingProps } = await import('../CanvasWorkspace');
const { GuidedLiveCanvas } = await import('./GuidedWorkbench');

const snapshot: LiveRunSnapshot = {
  run: { id: 'r1', status: 'RUNNING' },
  milestones: [{ id: 'M1', status: 'RUNNING' }],
  tasks: [{ id: 'T1', milestone_id: 'M1', status: 'PASSED' }],
  events: [], quotas: [],
};
const view = buildLiveRunGraph(snapshot, 'en');
const recordedEdge = 'live-edge-live-planner-to-live-task-T1';
const plannedEdge = 'live-edge-live-task-T1-to-live-ms-M1';
const handoffs = [{ id: 'planner>task:T1', recorded: true }, { id: 'task:T1>milestone:M1', recorded: false }] as RunHandoff[];

function draw(selection: Parameters<typeof GuidedLiveCanvas>[0]['selection'], locale: 'en' | 'zh' = 'en') {
  const onSelect = vi.fn();
  const html = renderToStaticMarkup(createElement(GuidedLiveCanvas, { view, handoffs, selection, locale, onSelect }));
  assert(canvas);
  return { html, onSelect, props: canvas };
}
const edge = (edges: Edge[], id: string) => edges.find((item) => item.id === id);
const node = (nodes: BatonFlowNode[], id: string) => nodes.find((item) => item.id === id);

beforeEach(() => { canvas = undefined; });

describe('the read-only relay graph', () => {
  test('turns editing off on the shared canvas and reports clicks on nodes, edges and empty space', () => {
    const { props, onSelect } = draw(null);
    expect(props.readOnly).toBe(true);
    props.onNodeClick!('live-ms-M1');
    expect(onSelect).toHaveBeenLastCalledWith({ kind: 'node', id: 'live-ms-M1' });
    props.onEdgeClick!(recordedEdge);
    expect(onSelect).toHaveBeenLastCalledWith({ kind: 'edge', id: recordedEdge });
    props.onPaneClick!();
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  test('without readOnly the canvas keeps exactly the editing it has today', () => {
    expect(canvasEditingProps()).toEqual({ deleteKeyCode: ['Backspace', 'Delete'] });
    expect(canvasEditingProps(false)).toEqual({ deleteKeyCode: ['Backspace', 'Delete'] });
    expect(canvasEditingProps(true)).toEqual({
      nodesDraggable: false, nodesConnectable: false, elementsSelectable: false, deleteKeyCode: null,
    });
  });

  test('recorded and planned-only edges are drawn differently, with a legend that says which is which', () => {
    const { html, props } = draw(null);
    expect(edge(props.edges, recordedEdge)?.style?.strokeDasharray).toBeUndefined();
    expect(edge(props.edges, plannedEdge)?.style?.strokeDasharray).toBe('6 5');
    expect(props.traversedEdgeIds.has(recordedEdge)).toBe(true);
    expect(props.traversedEdgeIds.has(plannedEdge)).toBe(false);
    expect(props.activeEdgeIds.has(plannedEdge)).toBe(false);
    expect(html).toContain(MESSAGES.en.guided.relay.legendRecorded);
    expect(html).toContain(MESSAGES.en.guided.relay.legendPlanned);
    expect(draw(null, 'zh').html).toContain(MESSAGES.zh.guided.relay.legendPlanned);
  });

  test('the selected node or edge is marked on the graph', () => {
    const picked = draw({ kind: 'edge', id: plannedEdge }).props;
    expect(edge(picked.edges, plannedEdge)?.className).toContain('guided-relay__edge--selected');
    expect(edge(picked.edges, plannedEdge)?.className).toContain('guided-relay__edge--unrecorded');
    expect(edge(picked.edges, recordedEdge)?.className ?? '').not.toContain('selected');
    expect(picked.nodes.some((item) => item.className?.includes('selected'))).toBe(false);

    const task = draw({ kind: 'node', id: 'live-task-T1' }).props;
    expect(node(task.nodes, 'live-task-T1')?.className).toBe('guided-relay__node--selected');
    expect(node(task.nodes, 'live-planner')?.className).toBeUndefined();
    expect(task.edges.some((item) => item.className?.includes('selected'))).toBe(false);
  });
});

describe('fitting the graph again when it grows', () => {
  test('the structure key changes with the steps and lines, not with their status', async () => {
    const { relayStructureKey } = await import('./GuidedWorkbench');
    const planning = buildLiveRunGraph({ run: { id: 'r1', status: 'PLANNING' }, milestones: [], tasks: [], events: [], quotas: [] }, 'en');
    const later = buildLiveRunGraph({ ...snapshot, tasks: [{ id: 'T1', milestone_id: 'M1', status: 'RUNNING' }] }, 'en');
    expect(relayStructureKey(planning)).not.toBe(relayStructureKey(view));
    expect(relayStructureKey(later)).toBe(relayStructureKey(view));
    expect(relayStructureKey(buildLiveRunGraph(snapshot, 'zh'))).toBe(relayStructureKey(view));
  });
});
