import './CanvasWorkspace.css';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type EdgeMouseHandler,
  type NodeMouseHandler,
  type OnConnect,
  type OnEdgesChange,
  type OnNodesChange,
  type OnSelectionChangeFunc,
} from '@xyflow/react';
import { useTheme } from '../theme';
import { tierForNodeType, type NodeTimingConfig } from '../types/graph';
import { BatonEdge, EDGE_TONE_COLORS, edgeSemanticTone } from './edges/BatonEdge';
import { BatonNode, TIER_COLORS, type BatonFlowNode, type BatonNodeData } from './nodes/BatonNode';
import { resolveDoctorTarget, type DoctorTargets, type ProviderHealthMap } from './nodes/readiness';

const NODE_TYPES_MAP = { baton: BatonNode };
const EDGE_TYPES_MAP = { baton: BatonEdge };

type WorkspaceReadiness = {
  providerHealth: ProviderHealthMap;
  doctorTargets?: DoctorTargets;
};

// The inspector and canvas are siblings. Keep one host snapshot across canvas remounts.
const initialReadiness: WorkspaceReadiness = {
  providerHealth: new Map([['host_native', { provider: 'host_native', ok: true, detail: '' }]]),
};
let workspaceReadiness = initialReadiness;
const readinessListeners = new Set<() => void>();

function subscribeToReadiness(listener: () => void) {
  readinessListeners.add(listener);
  return () => { readinessListeners.delete(listener); };
}

export function useWorkspaceReadiness() {
  return useSyncExternalStore(subscribeToReadiness, () => workspaceReadiness, () => initialReadiness);
}

export function updateWorkspaceReadiness(update?: (current: WorkspaceReadiness) => WorkspaceReadiness) {
  const next = update ? update(workspaceReadiness) : initialReadiness;
  if (workspaceReadiness === next) return;
  workspaceReadiness = next;
  for (const listener of readinessListeners) listener();
}

export type CanvasWorkspaceProps = {
  nodes: BatonFlowNode[];
  edges: Edge[];
  liveTiming?: Pick<BatonNodeData, 'server_now' | 'now_epoch_sec'> & {
    nodeTimings: ReadonlyMap<string, NodeTimingConfig>;
  };
  onNodesChange: OnNodesChange<BatonFlowNode>;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  onSelectionChange: (sel: { nodeId: string | null; edgeId: string | null }) => void;
  activeEdgeIds: ReadonlySet<string>;
  traversedEdgeIds: ReadonlySet<string>;
  /** Called with the clicked node's id (live task nodes are `live-task-<taskId>`). */
  onNodeClick?: (nodeId: string) => void;
  /** Called with the clicked edge's id. */
  onEdgeClick?: (edgeId: string) => void;
  /** Called when empty canvas space is clicked. */
  onPaneClick?: () => void;
  /** No dragging, connecting, selecting or deleting; panning, zooming and clicks still work. */
  readOnly?: boolean;
  children?: ReactNode;
};

/** Editing props for React Flow; without `readOnly` they are exactly what the editable canvas always used. */
export function canvasEditingProps(readOnly = false) {
  return readOnly
    ? { nodesDraggable: false, nodesConnectable: false, elementsSelectable: false, deleteKeyCode: null }
    : { deleteKeyCode: ['Backspace', 'Delete'] };
}

export function useReadinessTime(providerHealth: ProviderHealthMap) {
  const [readinessTime, setReadinessTime] = useState(Date.now);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    function updateTime() {
      const now = Date.now();
      setReadinessTime(now);
      let nextExpiry = Infinity;
      for (const { cooldown_until = 0 } of providerHealth.values()) {
        const expiry = cooldown_until * 1000;
        if (expiry > now) nextExpiry = Math.min(nextExpiry, expiry);
      }
      if (nextExpiry !== Infinity) {
        timer = setTimeout(updateTime, Math.min(Math.ceil(nextExpiry - now), 2_147_483_647));
      }
    }

    updateTime();
    return () => clearTimeout(timer);
  }, [providerHealth]);

  return readinessTime;
}

export function CanvasWorkspace({
  nodes,
  edges,
  liveTiming,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onSelectionChange,
  activeEdgeIds,
  traversedEdgeIds,
  onNodeClick,
  onEdgeClick,
  onPaneClick,
  readOnly,
  children,
}: CanvasWorkspaceProps) {
  const { theme } = useTheme();
  const { providerHealth, doctorTargets } = useWorkspaceReadiness();
  const readinessTime = useReadinessTime(providerHealth);

  const styledNodes = useMemo(() => nodes.map((node) => {
    const timing = liveTiming?.nodeTimings.get(node.id);
    return {
      ...node,
      data: {
        ...node.data,
        ...timing,
        server_now: timing ? liveTiming?.server_now : undefined,
        now_epoch_sec: timing ? liveTiming?.now_epoch_sec : undefined,
        providerHealth,
        readinessProvider: resolveDoctorTarget(node.data, doctorTargets).provider,
        readinessTime,
      },
    };
  }), [nodes, liveTiming, providerHealth, doctorTargets, readinessTime]);

  const styledEdges = useMemo(() => edges.map((edge) => {
    const active = activeEdgeIds.has(edge.id);
    const traversed = traversedEdgeIds.has(edge.id);
    const semanticTone = edgeSemanticTone(edge.sourceHandle);
    const palette = EDGE_TONE_COLORS[semanticTone];
    return {
      ...edge,
      type: 'baton',
      animated: false,
      data: {
        ...edge.data,
        active,
        traversed,
        semanticTone,
      },
      style: {
        ...edge.style,
        stroke: active ? palette.active : traversed ? palette.traversed : 'var(--slate)',
        strokeWidth: active ? 3 : traversed ? 2 : 1.5,
      },
    };
  }), [edges, activeEdgeIds, traversedEdgeIds]);

  const handleConnect = useCallback<OnConnect>((connection) => {
    const { source, sourceHandle, target, targetHandle } = connection;
    const edge = {
      ...connection,
      id: `e_${source}_${sourceHandle ?? 'out'}_${target}`,
      targetHandle: targetHandle ?? 'in',
    };
    onConnect(edge);
  }, [onConnect]);

  const handleSelectionChange = useCallback<OnSelectionChangeFunc<BatonFlowNode>>(({ nodes, edges }) => {
    onSelectionChange({ nodeId: nodes[0]?.id ?? null, edgeId: edges[0]?.id ?? null });
  }, [onSelectionChange]);

  const handleNodeClick = useCallback<NodeMouseHandler<BatonFlowNode>>((_event, node) => {
    onNodeClick?.(node.id);
  }, [onNodeClick]);

  const handleEdgeClick = useCallback<EdgeMouseHandler>((_event, edge) => {
    onEdgeClick?.(edge.id);
  }, [onEdgeClick]);

  return (
    <ReactFlowProvider>
      <div className="canvas-workspace" data-tour-id="canvas-workspace">
        <ReactFlow<BatonFlowNode>
          nodes={styledNodes}
          edges={styledEdges}
          nodeTypes={NODE_TYPES_MAP}
          edgeTypes={EDGE_TYPES_MAP}
          colorMode={theme}
          minZoom={0.2}
          fitView
          fitViewOptions={{ padding: 0.22, minZoom: 0.2 }}
          {...canvasEditingProps(readOnly)}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={handleConnect}
          onSelectionChange={handleSelectionChange}
          onNodeClick={onNodeClick ? handleNodeClick : undefined}
          onEdgeClick={onEdgeClick ? handleEdgeClick : undefined}
          onPaneClick={onPaneClick}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} color="var(--canvas-dot)" />
          <Controls showInteractive={!readOnly} />
          <MiniMap<BatonFlowNode>
            nodeColor={(node) => TIER_COLORS[tierForNodeType(node.data.nodeType, node.data.role)]}
            nodeBorderRadius={8}
          />
          {children}
        </ReactFlow>
      </div>
    </ReactFlowProvider>
  );
}
