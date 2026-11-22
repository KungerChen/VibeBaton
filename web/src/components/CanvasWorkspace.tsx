import './CanvasWorkspace.css';
import { useCallback, useMemo, type ReactNode } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type OnConnect,
  type OnEdgesChange,
  type OnNodesChange,
  type OnSelectionChangeFunc,
} from '@xyflow/react';
import { useTheme } from '../theme';
import { tierForNodeType } from '../types/graph';
import { BatonEdge, EDGE_TONE_COLORS, edgeSemanticTone } from './edges/BatonEdge';
import { BatonNode, TIER_COLORS, type BatonFlowNode } from './nodes/BatonNode';

const NODE_TYPES_MAP = { baton: BatonNode };
const EDGE_TYPES_MAP = { baton: BatonEdge };

export type CanvasWorkspaceProps = {
  nodes: BatonFlowNode[];
  edges: Edge[];
  onNodesChange: OnNodesChange<BatonFlowNode>;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  onSelectionChange: (sel: { nodeId: string | null; edgeId: string | null }) => void;
  activeEdgeIds: ReadonlySet<string>;
  traversedEdgeIds: ReadonlySet<string>;
  children?: ReactNode;
};

export function CanvasWorkspace({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onSelectionChange,
  activeEdgeIds,
  traversedEdgeIds,
  children,
}: CanvasWorkspaceProps) {
  const { theme } = useTheme();
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
        strokeWidth: active ? 3 : traversed ? 2 : 1.25,
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

  return (
    <ReactFlowProvider>
      <div className="canvas-workspace">
        <ReactFlow<BatonFlowNode>
          nodes={nodes}
          edges={styledEdges}
          nodeTypes={NODE_TYPES_MAP}
          edgeTypes={EDGE_TYPES_MAP}
          colorMode={theme}
          fitView
          deleteKeyCode={['Backspace', 'Delete']}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={handleConnect}
          onSelectionChange={handleSelectionChange}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} color="var(--canvas-dot)" />
          <Controls />
          <MiniMap<BatonFlowNode> nodeColor={(node) => TIER_COLORS[tierForNodeType(node.data.nodeType, node.data.role)]} />
          {children}
        </ReactFlow>
      </div>
    </ReactFlowProvider>
  );
}
