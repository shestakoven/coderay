import {
  Background,
  ControlButton,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
} from '@xyflow/react';
import ELK from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { useEffect, useMemo, useRef, type Dispatch } from 'react';
import { usePlanOverlay } from '../plan/overlay';
import { fitKey, layoutBounds, layoutGraph, type Bounds, type MapFlowNode } from './layout';
import type { MapAction, MapState } from './map-state';
import { nodeTypes } from './nodes';
import { graphSignature, visibleGraph } from './visible-graph';

const elk = new ELK({ workerUrl: elkWorkerUrl });
const FIT_PADDING = 0.1;

export function MapView({ state, dispatch }: { state: MapState; dispatch: Dispatch<MapAction> }) {
  const overlay = usePlanOverlay();
  const [nodes, setNodes, onNodesChange] = useNodesState<MapFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const graph = useMemo(
    () => (state.snapshot ? visibleGraph(state.snapshot, state.expanded, overlay.marks.ghosts) : null),
    [state.snapshot, state.expanded, overlay.marks.ghosts],
  );
  const signature = useMemo(() => (graph ? graphSignature(graph) : null), [graph]);
  const flowNodes = useMemo(
    () =>
      nodes.map((node) => {
        const selected = node.id === state.selected;
        const componentId = node.parentId ?? node.id;
        const className = overlay.dimOthers && !overlay.marks.components.has(componentId) ? 'plan-dim' : '';
        return !!node.selected === selected && (node.className ?? '') === className ? node : { ...node, selected, className };
      }),
    [nodes, state.selected, overlay.dimOthers, overlay.marks],
  );
  const bounds = useMemo(() => layoutBounds(nodes), [nodes]);
  const key = useMemo(() => fitKey(nodes), [nodes]);

  useEffect(() => {
    const componentId = overlay.focus?.componentIds[0];
    if (!componentId) return;
    dispatch({ type: 'select', id: componentId });
    const size = state.snapshot?.components.find((component) => component.id === componentId)?.files.length ?? 0;
    if (size <= 40 && !state.expanded.has(componentId)) dispatch({ type: 'toggle', componentId });
  }, [overlay.focus?.nonce]);

  // Keyed on the signature, not the graph: a snapshot that leaves the visible graph unchanged must not re-run ELK.
  useEffect(() => {
    if (!graph) return;
    let cancelled = false;
    layoutGraph(graph, state.expanded, elk).then(
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
  }, [signature, setNodes, setEdges]);

  return (
    <div className="map">
      <ReactFlow
        nodes={flowNodes}
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
        deleteKeyCode={null}
        minZoom={0.05}
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} showFitView={false}>
          <FitButton bounds={bounds} />
        </Controls>
        <MiniMap pannable zoomable />
        <FitOnNewComponents fitKey={key} bounds={bounds} />
        <CenterOnFocus />
      </ReactFlow>
    </div>
  );
}

function CenterOnFocus() {
  const { focus } = usePlanOverlay();
  const { fitView } = useReactFlow();
  useEffect(() => {
    const ids = focus?.componentIds ?? [];
    if (ids.length === 0) return;
    const timer = setTimeout(() => void fitView({ nodes: ids.map((id) => ({ id })), padding: 0.8, maxZoom: 1, duration: 300 }), 400);
    return () => clearTimeout(timer);
  }, [focus?.nonce, fitView]);
  return null;
}

function FitOnNewComponents({ fitKey: key, bounds }: { fitKey: string; bounds: Bounds | null }) {
  const { fitBounds } = useReactFlow();
  const fitted = useRef('');
  useEffect(() => {
    if (!bounds || !key || fitted.current === key) return;
    fitted.current = key;
    void fitBounds(bounds, { padding: FIT_PADDING });
  }, [key, bounds, fitBounds]);
  return null;
}

function FitButton({ bounds }: { bounds: Bounds | null }) {
  const { fitBounds } = useReactFlow();
  return (
    <ControlButton
      title="Fit View"
      aria-label="Fit View"
      disabled={!bounds}
      onClick={() => {
        if (bounds) void fitBounds(bounds, { padding: FIT_PADDING });
      }}
    >
      ⤢
    </ControlButton>
  );
}
