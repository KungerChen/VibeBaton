import { useCallback } from 'react';
import { addEdge, useEdgesState, useNodesState, type OnConnect } from '@xyflow/react';
import { CanvasWorkspace } from './components/CanvasWorkspace';
import { starter_2tier } from './data/presets/starter_2tier';
import { graphToFlow } from './engine/flowAdapter';

const starter = graphToFlow(starter_2tier);
const noHighlightedEdges: ReadonlySet<string> = new Set();
const ignoreSelection = () => {};

export default function App() {
  const [nodes, , onNodesChange] = useNodesState(starter.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(starter.edges);

  const onConnect = useCallback<OnConnect>((connection) => {
    setEdges((current) => {
      // The workspace ID is shared by connections that only differ by target handle.
      if ('id' in connection && current.some(({ id }) => id === connection.id)) return current;
      return addEdge(connection, current);
    });
  }, [setEdges]);

  return (
    <CanvasWorkspace
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onSelectionChange={ignoreSelection}
      activeEdgeIds={noHighlightedEdges}
      traversedEdgeIds={noHighlightedEdges}
    />
  );
}
