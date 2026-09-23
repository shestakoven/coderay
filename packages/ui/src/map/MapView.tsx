import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Edge,
} from '@xyflow/react';
import { useEffect, useMemo, useRef, type Dispatch } from 'react';
import { layoutGraph, type MapFlowNode } from './layout';
import type { MapAction, MapState } from './map-state';
import { nodeTypes } from './nodes';
import { visibleGraph } from './visible-graph';

export function MapView({ state, dispatch }: { state: MapState; dispatch: Dispatch<MapAction> }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<MapFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const graph = useMemo(
    () => (state.snapshot ? visibleGraph(state.snapshot, state.expanded) : null),
    [state.snapshot, state.expanded],
  );

  useEffect(() => {
    if (!graph) return;
    let cancelled = false;
    layoutGraph(graph, state.expanded).then(
      (layout) => {
        if (cancelled) return;
        setNodes(layout.nodes);
        setEdges(layout.edges);
      },
      (error: unknown) => console.error('map layout failed', error),
    );
    return () => {
      cancelled = true;
    };
  }, [graph, state.expanded, setNodes, setEdges]);

  return (
    <div className="map">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_event, node) => {
          dispatch({ type: 'select', id: node.id });
          if (node.type === 'component') dispatch({ type: 'toggle', componentId: node.id });
        }}
        onPaneClick={() => dispatch({ type: 'select', id: null })}
        nodesDraggable={false}
        nodesConnectable={false}
        minZoom={0.05}
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
        <FitOnFirstLayout hasNodes={nodes.length > 0} />
      </ReactFlow>
    </div>
  );
}

function FitOnFirstLayout({ hasNodes }: { hasNodes: boolean }) {
  const { fitView } = useReactFlow();
  const initialized = useNodesInitialized();
  const done = useRef(false);
  useEffect(() => {
    if (!hasNodes || !initialized || done.current) return;
    done.current = true;
    void fitView({ padding: 0.1 });
  }, [hasNodes, initialized, fitView]);
  return null;
}
