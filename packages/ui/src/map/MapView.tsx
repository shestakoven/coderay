import {
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import ELK from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { useEffect, useMemo, useRef, useState, type Dispatch } from 'react';
import { focusEdges, type MapEdge } from './edge-focus';
import { markCounts } from '../history/dialog-state';
import { MapBackground, MapControls } from './canvas';
import { PendingCountsContext, usePlanOverlay } from '../plan/overlay';
import { dimsNode } from '../plan/plan-state';
import { PromptPopover } from '../plan/PromptPopover';
import { mapAnchor } from '../plan/prompt-text';
import { fitKey, layoutBounds, layoutGraph, type Bounds, type MapFlowNode } from './layout';
import { LayoutMenu } from './LayoutMenu';
import { loadLayout, saveLayout, type LayoutSettings } from './layout-settings';
import type { MapAction, MapState } from './map-state';
import { nodeTypes } from './nodes';
import { graphSignature, visibleGraph } from './visible-graph';

const elk = new ELK({ workerUrl: elkWorkerUrl });
const FIT_PADDING = 0.1;

export function MapView({ state, dispatch }: { state: MapState; dispatch: Dispatch<MapAction> }) {
  const overlay = usePlanOverlay();
  const [nodes, setNodes, onNodesChange] = useNodesState<MapFlowNode>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [edges, setEdges, onEdgesChange] = useEdgesState<MapEdge>([]);
  const [layout, setLayout] = useState(() => loadLayout(window.localStorage));
  const changeLayout = (next: LayoutSettings) => {
    setLayout(next);
    saveLayout(window.localStorage, next);
  };
  const graph = useMemo(
    () => (state.snapshot ? visibleGraph(state.snapshot, state.expanded, overlay.marks.ghosts, true) : null),
    [state.snapshot, state.expanded, overlay.marks.ghosts],
  );
  const signature = useMemo(() => (graph ? graphSignature(graph) : null), [graph]);
  const promptNode = useMemo(
    () => (overlay.prompt ? mapAnchor(overlay.prompt, new Set(nodes.map((node) => node.id))) : null),
    [overlay.prompt, nodes],
  );
  const pendingCounts = useMemo(() => {
    const nodeIds = new Set(nodes.map((node) => node.id));
    const owner = new Map(state.snapshot?.files.map((file) => [file.path, file.componentId]) ?? []);
    const place = (path: string): string | null => {
      if (nodeIds.has(path)) return path;
      const component = owner.get(path);
      return component && nodeIds.has(component) ? component : null;
    };
    return markCounts([...[...overlay.eventFiles].map(place), ...overlay.prompts.map((p) => mapAnchor(p, nodeIds))]);
  }, [nodes, state.snapshot, overlay.eventFiles, overlay.prompts]);
  const focus = hovered ?? state.selected;
  const focused = useMemo(() => focusEdges(edges, focus), [edges, focus]);
  const flowNodes = useMemo(
    () =>
      nodes.map((node) => {
        const selected = node.id === state.selected;
        const componentId = node.parentId ?? node.id;
        const dim = dimsNode(overlay.marks, overlay.dimOthers, node.id, componentId) ? 'plan-dim' : '';
        const away = focused.neighbors !== null && !focused.neighbors.has(node.id) && node.parentId === undefined && !state.expanded.has(node.id);
        const className = [dim, away && 'map-away', pendingCounts.has(node.id) && 'oop-target'].filter(Boolean).join(' ');
        return !!node.selected === selected && (node.className ?? '') === className ? node : { ...node, selected, className };
      }),
    [nodes, state.selected, state.expanded, focused.neighbors, overlay.dimOthers, overlay.marks, pendingCounts],
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
    layoutGraph(graph, state.expanded, elk, layout).then(
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
  }, [signature, layout, setNodes, setEdges]);

  const { fitBounds } = useReactFlow();
  const layoutKey = `${layout.direction}/${layout.algorithm}/${layout.density}/${layout.detail}`;

  return (
    <PendingCountsContext.Provider value={pendingCounts}>
    <div className="map">
      <ReactFlow
        nodes={flowNodes}
        edges={focused.edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_event, node) => {
          dispatch({ type: 'select', id: node.id });
          if (node.type === 'component') dispatch({ type: 'toggle', componentId: node.id });
        }}
        onNodeMouseEnter={(_event, node) => setHovered(node.id)}
        onNodeMouseLeave={() => setHovered(null)}
        onPaneClick={() => dispatch({ type: 'select', id: null })}
        nodesDraggable={false}
        nodesConnectable={false}
        deleteKeyCode={null}
        minZoom={0.05}
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
      >
        <MapBackground />
        <MapControls disabled={!bounds} onFit={() => bounds && void fitBounds(bounds, { padding: FIT_PADDING })} />
        <FitOnNewComponents fitKey={`${key}|${layoutKey}`} bounds={bounds} />
        <CenterOnFocus />
        <PromptPopover nodeId={promptNode} />
      </ReactFlow>
      <LayoutMenu settings={layout} onChange={changeLayout} />
    </div>
    </PendingCountsContext.Provider>
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
