import { getViewportForBounds, MarkerType, ReactFlow, useReactFlow, useStoreApi, type Edge, type Node } from '@xyflow/react';
import type { PlanFlow, PlanView } from '@ide/protocol';
import ELK from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapBackground, MapControls } from '../map/canvas';
import { LayoutMenu } from '../map/LayoutMenu';
import { DEFAULT_LAYOUT, type Direction } from '../map/layout-settings';
import type { Bounds } from '../map/layout';
import { FlowCard, type FlowCardData, type FlowCardNode } from './FlowCard';
import { FlowDetails } from './FlowDetails';
import { FlowLink, type FlowLinkData, type FlowLinkEdge } from './FlowLink';
import { boundsOf, layoutFlow, positionsFor, type FlowLayouts, FLOW_NODE_SIZE } from './flow-layout';
import { edgePhase, focusSet, nodePhase, pickFocus, stepBadges, summarize, type FlowView } from './flow-model';
import { loadFlowDirection, saveFlowDirection } from './flow-settings';
import { EDGE_COLOR } from './flow-style';
import { useTweened } from './use-tweened';

const elk = new ELK({ workerUrl: elkWorkerUrl });
const FIT = { padding: { top: '110px', right: '48px', bottom: '70px', left: '48px' } } as const;
const nodeTypes = { card: FlowCard };
const edgeTypes = { link: FlowLink };

function Canvas({ plan, flow, view, direction, hoverStep }: { plan: PlanView; flow: PlanFlow; view: FlowView; direction: Direction; hoverStep: string | null }) {
  const [layouts, setLayouts] = useState<FlowLayouts | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const { setViewport } = useReactFlow();
  const store = useStoreApi();
  // fitBounds takes a single numeric padding, FIT is asymmetric.
  const fitTo = useCallback(
    (bounds: Bounds, duration?: number) => {
      const { width, height, minZoom, maxZoom } = store.getState();
      void setViewport(getViewportForBounds(bounds, width, height, minZoom, maxZoom, FIT.padding), { duration });
    },
    [store, setViewport],
  );

  useEffect(() => {
    let live = true;
    layoutFlow(elk, flow, direction).then(
      (next) => live && setLayouts(next),
      (error: unknown) => console.error('plan flow layout failed', error),
    );
    return () => { live = false; };
    // The canvas is keyed by plan version and direction, so the flow of this mount never changes.
  }, []);

  const target = useMemo(() => (layouts === null ? null : positionsFor(layouts, view)), [layouts, view]);
  const positions = useTweened(target);

  const visible = useMemo(() => flow.nodes.filter((node) => view === 'plan' || node.state !== 'create').map((node) => ({ id: node.id })), [flow, view]);
  const destination = useMemo(() => (target === null ? null : boundsOf(target, visible.map((node) => node.id))), [target, visible]);

  const shownView = useRef(view);
  useEffect(() => {
    if (shownView.current === view) return;
    shownView.current = view;
    if (destination) fitTo(destination, 480);
  }, [view, destination, fitTo]);

  const selectedNode = flow.nodes.find((node) => node.id === selected && (view === 'plan' || node.state !== 'create')) ?? null;
  const focus = focusSet(flow, pickFocus(hoverStep, hoverNode, selectedNode?.id ?? null));
  const kinds = useMemo(() => new Map(flow.nodes.map((node) => [node.id, node.kind])), [flow]);

  const nodes: FlowCardNode[] = useMemo(
    () => flow.nodes.map((node) => ({
      id: node.id,
      type: 'card',
      position: positions?.get(node.id) ?? { x: 0, y: 0 },
      width: FLOW_NODE_SIZE.width,
      height: FLOW_NODE_SIZE.height,
      style: view === 'now' && node.state === 'create' ? { pointerEvents: 'none' } : undefined,
      data: {
        node, view, phase: nodePhase(plan, node), badges: stepBadges(plan, node), direction,
        hot: focus?.nodes.has(node.id) ?? false, dim: focus !== null && !focus.nodes.has(node.id), selected: selectedNode?.id === node.id,
      } satisfies FlowCardData,
    })),
    [flow, plan, positions, view, direction, focus, selectedNode?.id],
  );

  const edges: FlowLinkEdge[] = useMemo(
    () => flow.edges.map((edge, index) => {
      const phase = edgePhase(plan, edge);
      const shown = view === 'now' ? 'existing' : edge.state;
      const color = shown === 'removed' ? EDGE_COLOR.removed : shown === 'new' ? (phase === 'done' ? EDGE_COLOR.done : EDGE_COLOR.new) : EDGE_COLOR.existing;
      return {
        id: `e${index}`,
        source: edge.from,
        target: edge.to,
        type: 'link',
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        data: { edge, view, phase, test: kinds.get(edge.from) === 'test', hot: focus?.edges.has(index) ?? false, dim: focus !== null && !focus.edges.has(index) } satisfies FlowLinkData,
      };
    }),
    [flow, plan, view, kinds, focus],
  );

  if (positions === null) return null;

  return (
    <>
      <ReactFlow
        fitView
        fitViewOptions={{ ...FIT, nodes: visible }}
        nodes={nodes as Node[]}
        edges={edges as Edge[]}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        minZoom={0.3}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => setSelected(selected === node.id ? null : node.id)}
        onNodeMouseEnter={(_, node) => setHoverNode(node.id)}
        onNodeMouseLeave={() => setHoverNode(null)}
        onPaneClick={() => setSelected(null)}
      >
        <MapBackground />
        <MapControls disabled={!destination} onFit={() => destination && fitTo(destination)} />
      </ReactFlow>
      {selectedNode && <FlowDetails plan={plan} flow={flow} node={selectedNode} view={view} onClose={() => setSelected(null)} />}
    </>
  );
}

export function PlanFlowView({ plan, flow, hoverStep }: { plan: PlanView; flow: PlanFlow; hoverStep: string | null }) {
  const [view, setView] = useState<FlowView>('plan');
  const [direction, setDirection] = useState<Direction>(() => loadFlowDirection(window.localStorage));
  const stats = summarize(flow);
  const changeDirection = (next: Direction): void => {
    setDirection(next);
    saveFlowDirection(window.localStorage, next);
  };
  return (
    <div className="pf-canvas" data-testid="plan-flow">
      <Canvas key={`${plan.id}@${plan.version}:${direction}`} plan={plan} flow={flow} view={view} direction={direction} hoverStep={hoverStep} />
      <div className="pf-float pf-row">
        <LayoutMenu settings={{ ...DEFAULT_LAYOUT, direction }} fields={['direction']} onChange={(next) => changeDirection(next.direction)} />
        <div className="pf-seg">
          <button type="button" className={view === 'now' ? 'on' : ''} onClick={() => setView('now')}>Now</button>
          <button type="button" className={view === 'plan' ? 'on' : ''} onClick={() => setView('plan')}>After the plan</button>
        </div>
        <div className={`pf-impact${view === 'now' ? ' off' : ''}`}>
          {stats.created > 0 && <span className="pf-stat create"><b>{stats.created}</b> new</span>}
          {stats.modified > 0 && <span className="pf-stat modify"><b>{stats.modified}</b> modified</span>}
          {stats.removed > 0 && <span className="pf-stat delete"><b>{stats.removed}</b> removed</span>}
          <span className="pf-stat"><b>{stats.links}</b> new links</span>
          <span className="pf-stat"><b>{stats.files}</b> files</span>
        </div>
      </div>
      <div className="pf-float pf-legend">
        <span><i className="lg existing" />existing</span>
        <span><i className="lg modify" />modified</span>
        <span><i className="lg create" />new</span>
        <span><i className="lg delete" />removed</span>
      </div>
    </div>
  );
}
