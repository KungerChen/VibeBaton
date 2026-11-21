import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { addEdge, useEdgesState, useNodesState, type OnConnect } from '@xyflow/react';
import { BatonApiClient, type ApiMode } from './api/client';
import { CanvasWorkspace } from './components/CanvasWorkspace';
import { HeaderBar } from './components/HeaderBar';
import { LeftSidebar } from './components/LeftSidebar';
import { PlaybackBar } from './components/PlaybackBar';
import { RightInspector } from './components/RightInspector';
import type { EdgePatch, NodePatch } from './components/types';
import { ToastHost, useToasts } from './components/ui/Toast';
import { findPreset, flagship_4tier, starter_2tier } from './data/presets';
import { STAGE1_REPLAY_TRACE } from './data/stage1Replay';
import { flowToGraph, graphToFlow } from './engine/flowAdapter';
import { deriveStates, stepIntervalMs } from './engine/playback';
import { buildShareUrl, decodeRecipeHash, encodeRecipeHash } from './engine/shareUrl';
import type {
  GraphTraceEvent,
  GraphValidationResult,
  NodeType,
  PresetItem,
  Scenario,
  WorkflowGraph,
  WorkflowNode,
} from './types/graph';

const starter = graphToFlow(starter_2tier);
const emptySelection: { nodeId: string | null; edgeId: string | null } = { nodeId: null, edgeId: null };
const emptyTrace: GraphTraceEvent[] = [];
const initialPlayback = { stepIndex: 0, playing: false };
const panes = [
  { id: 'canvas', label: 'Canvas' },
  { id: 'sidebar', label: 'Sidebar' },
  { id: 'inspector', label: 'Inspector' },
] as const;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function newWorkflowNode(type: NodeType, nodes: WorkflowNode[]): WorkflowNode {
  const label = type.replace('_node', '');
  const count = nodes.length;
  const ids = new Set(nodes.map(({ id }) => id));
  let number = count + 1;
  while (ids.has(`${label}_${number}`)) number += 1;

  const config: NonNullable<WorkflowNode['config']> = {};
  if (type === 'gate_node' || type === 'reviewer_node') config.max_loops = 2;
  if (type === 'worker_node' || type === 'planner_node') {
    const { provider, model } = nodes.find((node) => node.type === type)?.config ?? {};
    if (typeof provider === 'string') config.provider = provider;
    if (typeof model === 'string') config.model = model;
  }

  const offset = 120 + 40 * count;
  return { id: `${label}_${number}`, type, label, position: { x: offset, y: offset }, config };
}

export default function App() {
  const clientRef = useRef<BatonApiClient | null>(null);
  if (clientRef.current === null) clientRef.current = new BatonApiClient();
  const client = clientRef.current;
  const initialization = useRef<Promise<ApiMode> | null>(null);
  const latestPresetRequest = useRef(0);
  const [mode, setMode] = useState<ApiMode | null>(null);
  const [presets, setPresets] = useState<PresetItem[]>([]);
  const [baseGraph, setBaseGraph] = useState<WorkflowGraph>(starter_2tier);
  const [nodes, setNodes, onNodesChange] = useNodesState(starter.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(starter.edges);
  const [selection, setSelection] = useState(emptySelection);
  const [pane, setPane] = useState<(typeof panes)[number]['id']>('canvas');
  const [canvasKey, setCanvasKey] = useState(0);
  const [scenario, setScenario] = useState<Scenario>('happy_path');
  const [replayActive, setReplayActive] = useState(false);
  const replayActiveRef = useRef(false);
  replayActiveRef.current = replayActive;
  const [playback, setPlayback] = useState(initialPlayback);
  const [speed, setSpeed] = useState(1);
  const [checkedGraph, setCheckedGraph] = useState<{
    structure: string;
    result: GraphValidationResult;
  } | null>(null);
  const [simulation, setSimulation] = useState<{
    validation: GraphValidationResult;
    scenario: Scenario;
    trace: GraphTraceEvent[];
  } | null>(null);
  const { toasts, push } = useToasts();

  const graph = useMemo(() => flowToGraph(baseGraph, nodes, edges), [baseGraph, nodes, edges]);
  // Only workflow changes invalidate playback. Layout edits still go into exports.
  const structure = useMemo(() => JSON.stringify({
    ...graph,
    nodes: graph.nodes.map(({ position, ...node }) => node),
  }), [graph]);
  const getGraph = useEffectEvent(() => graph);
  const validation = checkedGraph?.structure === structure ? checkedGraph.result : null;
  const trace = replayActive
    ? STAGE1_REPLAY_TRACE
    : simulation?.validation === validation && simulation.scenario === scenario
      ? simulation.trace
      : emptyTrace;
  const stepIndex = Math.min(playback.stepIndex, trace.length);
  const playing = playback.playing && trace.length > 0;
  const resetPlayback = useCallback(() => setPlayback(initialPlayback), []);

  useEffect(() => {
    let active = true;

    async function initialize() {
      try {
        const nextMode = await (initialization.current ??= client.init());
        if (!active) return;
        setMode(nextMode);
        const items = await client.listPresets();
        if (active) setPresets(items);
      } catch (error) {
        if (active) push(errorMessage(error), 'err');
      }
    }

    void initialize();
    return () => { active = false; };
  }, [client, push]);

  useEffect(() => {
    if (mode === null) return;
    let active = true;
    setCheckedGraph(null);
    const timer = setTimeout(async () => {
      try {
        const result = await client.validate(getGraph());
        if (active) setCheckedGraph({ structure, result });
      } catch (error) {
        if (active) push(errorMessage(error), 'err');
      }
    }, 300);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, mode, push, structure]);

  const loadSharedHash = useEffectEvent(() => {
    if (typeof window === 'undefined') return;
    const decoded = decodeRecipeHash(window.location.hash);
    if (!decoded) return;
    if ('error' in decoded) {
      push(`Invalid shared recipe link: ${decoded.error}`, 'err');
      return;
    }
    latestPresetRequest.current += 1;
    setReplayActive(false);
    replaceGraph(decoded.graph);
    push(`Loaded shared recipe: ${decoded.graph.name}`);
  });

  useEffect(() => {
    loadSharedHash();
  }, []);

  useEffect(() => {
    setSimulation(null);
    if (!replayActiveRef.current) resetPlayback();
    if (!validation?.valid) return;
    let active = true;
    const validGraph = validation;

    async function simulate() {
      try {
        const result = await client.simulate(getGraph(), scenario);
        if (active) setSimulation({ validation: validGraph, scenario, trace: result.trace });
      } catch (error) {
        if (active) push(errorMessage(error), 'err');
      }
    }

    void simulate();
    return () => { active = false; };
  }, [client, push, resetPlayback, scenario, validation]);

  const stepCount = trace.length;
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setPlayback((current) => {
        if (!current.playing) return current;
        const next = Math.min(current.stepIndex + 1, stepCount);
        return { stepIndex: next, playing: next < stepCount };
      });
    }, stepIntervalMs(speed));
    return () => clearInterval(timer);
  }, [playing, speed, stepCount]);

  const { nodeStates, activeEdgeIds, traversedEdgeIds, currentEvent } = useMemo(
    () => deriveStates(graph, trace, trace[stepIndex - 1]?.seq ?? -1),
    [graph, trace, stepIndex],
  );
  useEffect(() => {
    setNodes((current) => {
      let changed = false;
      const next = current.map((node) => {
        const state = nodeStates[node.id] ?? 'idle';
        if (node.data.state === state) return node;
        changed = true;
        return { ...node, data: { ...node.data, state } };
      });
      return changed ? next : current;
    });
  }, [nodeStates, setNodes]);

  function replaceGraph(nextGraph: WorkflowGraph) {
    const flow = graphToFlow(nextGraph);
    setBaseGraph(nextGraph);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setSelection(emptySelection);
    setCanvasKey((key) => key + 1);
    resetPlayback();
  }

  async function onSelectPreset(id: string) {
    const request = ++latestPresetRequest.current;
    try {
      const preset = mode === 'local' ? await client.getPreset(id) : findPreset(id);
      if (!preset) throw new Error(`Unknown preset '${id}'`);
      if (request === latestPresetRequest.current) {
        setReplayActive(false);
        replaceGraph(preset);
      }
    } catch (error) {
      if (request === latestPresetRequest.current) push(errorMessage(error), 'err');
    }
  }

  function onAddNode(type: NodeType) {
    const node = newWorkflowNode(type, graph.nodes);
    const flow = graphToFlow({ ...graph, nodes: [node], edges: [] });
    setReplayActive(false);
    setBaseGraph({ ...graph, nodes: [...graph.nodes, node] });
    setNodes((current) => [...current, ...flow.nodes]);
  }

  function onImportGraph(imported: WorkflowGraph) {
    latestPresetRequest.current += 1;
    setReplayActive(false);
    replaceGraph(imported);
    push(`Imported ${imported.name}`);
  }

  function onExport() {
    const blob = new Blob([JSON.stringify(graph, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${graph.id}.baton.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function onShare() {
    try {
      const hash = encodeRecipeHash(graph);
      const url = buildShareUrl(graph, window.location.href);
      window.history.replaceState(null, '', hash);
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        push('Shareable link copied to clipboard');
      } else {
        push('Shareable URL updated in address bar');
      }
    } catch (error) {
      push(errorMessage(error), 'err');
    }
  }

  function onScenarioSelect(nextScenario: Scenario) {
    setReplayActive(false);
    setScenario(nextScenario);
    resetPlayback();
  }

  function onToggleReplay() {
    if (replayActive) {
      setReplayActive(false);
      resetPlayback();
      return;
    }
    latestPresetRequest.current += 1;
    if (graph.id !== flagship_4tier.id) replaceGraph(flagship_4tier);
    setReplayActive(true);
    setPlayback({ stepIndex: 1, playing: true });
    push('Stage 1 Real Run (v0.2.0 · 107m @ 60×) loaded');
  }

  function onUpdateNode(id: string, patch: NodePatch) {
    setNodes((current) => current.map((node) => node.id === id
      ? { ...node, data: { ...node.data, ...patch, label: patch.label ?? node.data.label } }
      : node));
  }

  function onUpdateEdge(id: string, patch: EdgePatch) {
    const { max_loops, ...handles } = patch;
    setEdges((current) => current.map((edge) => {
      if (edge.id !== id) return edge;
      const updated = { ...edge, ...handles };
      if ('max_loops' in patch) updated.data = { ...edge.data, max_loops };
      const { sourceHandle } = updated;
      updated.label = sourceHandle === 'out' || sourceHandle === 'dag' ? undefined : sourceHandle;
      return updated;
    }));
  }

  const onConnect = useCallback<OnConnect>((connection) => {
    setEdges((current) => {
      // The workspace ID is shared by connections that only differ by target handle.
      if ('id' in connection && current.some(({ id }) => id === connection.id)) return current;
      return addEdge(connection, current);
    });
  }, [setEdges]);

  function onPlayPause() {
    setPlayback((current) => current.playing
      ? { ...current, playing: false }
      : { stepIndex: current.stepIndex >= stepCount ? 0 : current.stepIndex, playing: true });
  }

  function onJumpToStep(index: number) {
    setPlayback({ stepIndex: Math.min(Math.max(index, 0), stepCount), playing: false });
  }

  const version = client.health?.version;
  return (
    <div className="app">
      <HeaderBar mode={mode ?? 'demo'} version={typeof version === 'string' ? version : undefined} graphName={graph.name} />
      <nav className="app-tabs tabs" aria-label="Workspace views">
        {panes.map(({ id, label }) => (
          <button
            className={`tab${pane === id ? ' tab--active' : ''}`}
            key={id}
            type="button"
            aria-pressed={pane === id}
            aria-controls={`workspace-${id}`}
            onClick={() => setPane(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="app-pane app-pane--sidebar" id="workspace-sidebar" data-active={pane === 'sidebar'}>
        <LeftSidebar
          presets={presets}
          currentGraphId={graph.id}
          onSelectPreset={onSelectPreset}
          onAddNode={onAddNode}
          onImportGraph={onImportGraph}
          onExport={onExport}
          onShare={onShare}
          validation={validation}
        />
      </div>
      <main className="app-pane app-pane--canvas" id="workspace-canvas" data-active={pane === 'canvas'}>
        <CanvasWorkspace
          key={canvasKey}
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onSelectionChange={setSelection}
          activeEdgeIds={activeEdgeIds}
          traversedEdgeIds={traversedEdgeIds}
        >
          <PlaybackBar
            scenario={scenario}
            onScenarioChange={onScenarioSelect}
            replayActive={replayActive}
            onToggleReplay={onToggleReplay}
            playing={playing}
            onPlayPause={onPlayPause}
            onStep={() => onJumpToStep(stepIndex + 1)}
            onReset={resetPlayback}
            speed={speed}
            onSpeedChange={setSpeed}
            stepIndex={stepIndex}
            stepCount={stepCount}
            currentEvent={currentEvent}
            disabled={stepCount === 0}
          />
        </CanvasWorkspace>
      </main>
      <div className="app-pane app-pane--inspector" id="workspace-inspector" data-active={pane === 'inspector'}>
        <RightInspector
          mode={mode ?? 'demo'}
          client={client}
          graph={graph}
          selectedNodeId={selection.nodeId}
          selectedEdgeId={selection.edgeId}
          onUpdateNode={onUpdateNode}
          onUpdateEdge={onUpdateEdge}
          trace={trace}
          stepIndex={stepIndex}
          onJumpToStep={onJumpToStep}
          onToast={push}
        />
      </div>
      <ToastHost toasts={toasts} />
    </div>
  );
}
