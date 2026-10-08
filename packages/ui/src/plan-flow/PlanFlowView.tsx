import { getViewportForBounds, MarkerType, ReactFlow, useReactFlow, useStoreApi, type Edge, type Node } from '@xyflow/react';
import type { PlanAnswer, PlanFlow, PlanView } from '@ide/protocol';
import ELK from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { MapBackground, MapControls } from '../map/canvas';
import { LayoutMenu } from '../map/LayoutMenu';
import { DEFAULT_LAYOUT, type Direction } from '../map/layout-settings';
import type { Bounds } from '../map/layout';
import { FlowCard, type FlowCardData, type FlowCardNode } from './FlowCard';
import { FlowDetails, type FlowSelection } from './FlowDetails';
import { FlowLink, type FlowLinkData, type FlowLinkEdge } from './FlowLink';
import { boundsOf, layoutFlow, positionsFor, type FlowLayouts, FLOW_NODE_SIZE, type Positions } from './flow-layout';
import { edgePhase, focusSet, nodePhase, stepBadges, summarize, type FlowView, type FocusSet } from './flow-model';
import { loadFlowDirection, saveFlowDirection } from './flow-settings';
import { EDGE_COLOR } from './flow-style';
import { SteerBar, type BarPhase } from './SteerBar';
import { SteerRail } from './SteerRail';
import { describe, draftReducer, edgeKey, EMPTY_DRAFT, isAsk, message, nodeKey, viewOf, withAsks, type DraftView } from './steer';
import { useTweened } from './use-tweened';

const elk = new ELK({ workerUrl: elkWorkerUrl });
const nodeTypes = { card: FlowCard };
const edgeTypes = { link: FlowLink };
const ASK_COLOR = '#b392f0';
// A small plan must not be blown up: cards, tools and editors stay at their natural size.
const FIT_MAX_ZOOM = 1;

type Editor = { kind: 'note'; target: string } | { kind: 'ask'; after: string } | null;

interface MapActions {
  openNote: (target: string) => void;
  openAsk: (after: string) => void;
  remove: (id: string) => void;
  saveNote: (target: string, text: string) => void;
  saveAsk: (after: string, text: string) => void;
  cancel: () => void;
}

// fitBounds takes a single numeric padding; the rail and the answer bar need an asymmetric one.
const padding = (railOpen: boolean, bar: boolean) => ({ top: '110px', right: '48px', bottom: bar ? '112px' : '70px', left: railOpen ? '348px' : '48px' }) as const;

function inside(positions: Positions, ids: readonly string[], transform: { x: number; y: number; zoom: number }, size: { width: number; height: number }, railOpen: boolean, bar: boolean): boolean {
  const pad = { top: 90, right: 32, bottom: bar ? 96 : 56, left: railOpen ? 332 : 32 };
  return ids.every((id) => {
    const at = positions.get(id);
    if (at === undefined) return true;
    const left = at.x * transform.zoom + transform.x;
    const top = at.y * transform.zoom + transform.y;
    return left >= pad.left && top >= pad.top && left + FLOW_NODE_SIZE.width * transform.zoom <= size.width - pad.right && top + FLOW_NODE_SIZE.height * transform.zoom <= size.height - pad.bottom;
  });
}

interface CanvasProps {
  plan: PlanView;
  flow: PlanFlow;
  view: FlowView;
  direction: Direction;
  hoverStep: string | null;
  draft: DraftView;
  tools: boolean;
  selection: FlowSelection | null;
  onSelect: (selection: FlowSelection | null) => void;
  editor: Editor;
  act: MapActions;
  railOpen: boolean;
  bar: boolean;
}

function Canvas({ plan, flow, view, direction, hoverStep, draft, tools, selection, onSelect, editor, act, railOpen, bar }: CanvasProps) {
  const [layouts, setLayouts] = useState<FlowLayouts | null>(null);
  const [rawHoverNode, setHoverNode] = useState<string | null>(null);
  const [rawHoverEdge, setHoverEdge] = useState<number | null>(null);
  const leave = useRef<number | undefined>(undefined);
  const { setViewport } = useReactFlow();
  const store = useStoreApi();
  const fitTo = useCallback(
    (bounds: Bounds, duration?: number) => {
      const { width, height, minZoom, maxZoom } = store.getState();
      void setViewport(getViewportForBounds(bounds, width, height, minZoom, Math.min(maxZoom, FIT_MAX_ZOOM), padding(railOpen, bar)), { duration });
    },
    [store, setViewport, railOpen, bar],
  );

  // Layout follows the shape of the flow: a request adds a part, so it runs again; a skipped hover does not.
  const signature = useMemo(() => `${flow.nodes.map((node) => node.id).join()}|${flow.edges.map((edge) => `${edge.from}>${edge.to}`).join()}`, [flow]);
  const settled = useRef(signature);
  const refit = useRef(false);
  useEffect(() => {
    let live = true;
    layoutFlow(elk, flow, direction).then(
      (next) => live && setLayouts(next),
      (error: unknown) => console.error('plan flow layout failed', error),
    );
    return () => { live = false; };
  }, [signature, direction]); // eslint-disable-line react-hooks/exhaustive-deps

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

  useEffect(() => {
    if (settled.current !== signature) refit.current = true;
  }, [signature]);
  // A request changes the layout; nothing may land off screen.
  useEffect(() => {
    if (!refit.current || target === null || destination === null) return;
    refit.current = false;
    settled.current = signature;
    const { transform, width, height } = store.getState();
    if (!inside(target, visible.map((node) => node.id), { x: transform[0], y: transform[1], zoom: transform[2] }, { width, height }, railOpen, bar)) fitTo(destination, 520);
  }, [layouts]); // eslint-disable-line react-hooks/exhaustive-deps

  const hoverNodeIn = useCallback((id: string | null) => {
    window.clearTimeout(leave.current);
    if (id !== null) setHoverNode(id);
    else leave.current = window.setTimeout(() => setHoverNode(null), 90);
  }, []);
  const hoverEdgeIn = useCallback((index: number | null) => {
    window.clearTimeout(leave.current);
    if (index !== null) setHoverEdge(index);
    else leave.current = window.setTimeout(() => setHoverEdge(null), 120);
  }, []);

  // The hovered part may be gone when the draft is sent: a request leaves the map with it.
  const hoverNode = rawHoverNode !== null && flow.nodes.some((node) => node.id === rawHoverNode) ? rawHoverNode : null;
  const hoverEdge = rawHoverEdge !== null && rawHoverEdge < flow.edges.length ? rawHoverEdge : null;
  const selectedNodeId = selection?.t === 'node' && flow.nodes.some((node) => node.id === selection.id && (view === 'plan' || node.state !== 'create')) ? selection.id : null;
  const selectedEdge = selection?.t === 'edge' && selection.i < flow.edges.length ? selection.i : null;

  const focus: FocusSet | null = useMemo(() => {
    if (hoverStep !== null) return focusSet(flow, { step: hoverStep });
    const edgeIndex = hoverEdge ?? (hoverNode === null ? selectedEdge : null);
    if (edgeIndex !== null) {
      const edge = flow.edges[edgeIndex]!;
      return { nodes: new Set([edge.from, edge.to]), edges: new Set([edgeIndex]) };
    }
    const nodeId = hoverNode ?? selectedNodeId;
    return nodeId === null ? null : focusSet(flow, { node: nodeId });
  }, [flow, hoverStep, hoverEdge, hoverNode, selectedEdge, selectedNodeId]);

  const kinds = useMemo(() => new Map(flow.nodes.map((node) => [node.id, node.kind])), [flow]);

  const nodes: FlowCardNode[] = useMemo(
    () => flow.nodes.map((node) => ({
      id: node.id,
      type: 'card',
      position: positions?.get(node.id) ?? { x: 0, y: 0 },
      width: FLOW_NODE_SIZE.width,
      height: FLOW_NODE_SIZE.height,
      style: view === 'now' && node.state === 'create' ? { pointerEvents: 'none' } : undefined,
      zIndex: selectedNodeId === node.id || hoverNode === node.id ? 20 : undefined,
      data: {
        node, view, phase: nodePhase(plan, node), badges: stepBadges(plan, node), direction,
        hot: focus?.nodes.has(node.id) ?? false,
        dim: focus !== null && !focus.nodes.has(node.id),
        selected: selectedNodeId === node.id,
        steer: {
          tools,
          note: draft.notes.get(nodeKey(node.id)),
          editor: editor?.kind === 'note' && editor.target === nodeKey(node.id) ? 'note' : editor?.kind === 'ask' && editor.after === node.id ? 'ask' : null,
          actions: {
            note: () => act.openNote(nodeKey(node.id)),
            ask: () => act.openAsk(node.id),
            remove: () => act.remove(node.id),
            saveNote: (text) => act.saveNote(nodeKey(node.id), text),
            saveAsk: (text) => act.saveAsk(node.id, text),
            cancel: act.cancel,
          },
        },
      } satisfies FlowCardData,
    })),
    [flow, plan, positions, view, direction, focus, selectedNodeId, hoverNode, draft, tools, editor, act],
  );

  const edges: FlowLinkEdge[] = useMemo(
    () => flow.edges.map((edge, index) => {
      const phase = edgePhase(plan, edge);
      const ask = isAsk(edge.to);
      const shown = view === 'now' ? 'existing' : edge.state;
      const color = ask ? ASK_COLOR : shown === 'removed' ? EDGE_COLOR.removed : shown === 'new' ? (phase === 'done' ? EDGE_COLOR.done : EDGE_COLOR.new) : EDGE_COLOR.existing;
      return {
        id: `e${index}`,
        source: edge.from,
        target: edge.to,
        type: 'link',
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        data: {
          edge, view, phase, test: kinds.get(edge.from) === 'test', ask,
          hot: focus?.edges.has(index) ?? false,
          dim: focus !== null && !focus.edges.has(index),
          selected: selectedEdge === index,
          steer: {
            tools, index,
            note: draft.notes.get(edgeKey(index)),
            editing: editor?.kind === 'note' && editor.target === edgeKey(index),
            active: hoverEdge === index || selectedEdge === index,
            onHover: hoverEdgeIn,
            onSelect: () => onSelect({ t: 'edge', i: index }),
            onNote: () => act.openNote(edgeKey(index)),
            onSave: (text) => act.saveNote(edgeKey(index), text),
            onCancel: act.cancel,
          },
        } satisfies FlowLinkData,
      };
    }),
    [flow, plan, view, kinds, focus, draft, tools, editor, act, hoverEdge, hoverEdgeIn, selectedEdge, onSelect],
  );

  if (positions === null) return null;

  return (
    <ReactFlow
      fitView
      fitViewOptions={{ padding: padding(railOpen, bar), nodes: visible, maxZoom: FIT_MAX_ZOOM }}
      nodes={nodes as Node[]}
      edges={edges as Edge[]}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      deleteKeyCode={null}
      selectionKeyCode={null}
      zoomOnDoubleClick={false}
      minZoom={0.3}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, node) => onSelect(selectedNodeId === node.id ? null : { t: 'node', id: node.id })}
      onEdgeClick={(_, edge) => onSelect({ t: 'edge', i: Number(edge.id.slice(1)) })}
      onNodeMouseEnter={(_, node) => hoverNodeIn(node.id)}
      onNodeMouseLeave={() => hoverNodeIn(null)}
      onEdgeMouseEnter={(_, edge) => hoverEdgeIn(Number(edge.id.slice(1)))}
      onEdgeMouseLeave={() => hoverEdgeIn(null)}
      onPaneClick={() => onSelect(null)}
    >
      <MapBackground />
      <MapControls disabled={!destination} onFit={() => destination && fitTo(destination)} />
    </ReactFlow>
  );
}

const isTyping = (target: EventTarget | null): boolean => target instanceof HTMLElement && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable);

interface WorkspaceProps {
  plan: PlanView;
  flow: PlanFlow;
  hoverStep: string | null;
  onAnswer: (answer: PlanAnswer) => void;
  view: FlowView;
  onView: (view: FlowView) => void;
  direction: Direction;
  onDirection: (direction: Direction) => void;
  railOpen: boolean;
  onRail: (open: boolean) => void;
}

// One plan version: the draft, the selection and the open editor live and die with it.
function Workspace({ plan, flow: planFlow, hoverStep, onAnswer, view, onView, direction, onDirection, railOpen, onRail }: WorkspaceProps) {
  const [draft, dispatch] = useReducer(draftReducer, EMPTY_DRAFT);
  const [selection, setSelection] = useState<FlowSelection | null>(null);
  const [editor, setEditor] = useState<Editor>(null);
  const [railStep, setRailStep] = useState<string | null>(null);

  const waiting = plan.status === 'proposed';
  const barPhase: BarPhase | null = waiting ? 'idle' : plan.status === 'changes-requested' ? 'sending' : null;
  const dv = useMemo(() => viewOf(draft.present), [draft.present]);
  const flow = useMemo(() => withAsks(planFlow, dv.asks), [planFlow, dv.asks]);
  const items = useMemo(() => describe(draft.present, flow), [draft.present, flow]);
  const text = useMemo(() => message(items), [items]);
  const stats = useMemo(() => summarize(planFlow), [planFlow]);

  const act: MapActions = useMemo(() => ({
    openNote: (target) => {
      setEditor({ kind: 'note', target });
      setSelection(target.startsWith('n:') ? { t: 'node', id: target.slice(2) } : { t: 'edge', i: Number(target.slice(2)) });
    },
    openAsk: (after) => {
      setEditor({ kind: 'ask', after });
      setSelection({ t: 'node', id: after });
    },
    remove: (id) => {
      dispatch({ t: 'unask', id });
      setSelection(null);
    },
    saveNote: (target, noteText) => {
      dispatch({ t: 'note', target, text: noteText });
      setEditor(null);
    },
    saveAsk: (after, askText) => {
      dispatch({ t: 'ask', after, text: askText });
      setEditor(null);
    },
    cancel: () => setEditor(null),
  }), []);

  const send = useCallback(() => {
    if (draft.present.length === 0) return;
    onAnswer({ kind: 'changes', feedback: text });
    setEditor(null);
    setSelection(null);
    dispatch({ t: 'clear' });
  }, [draft.present.length, onAnswer, text]);
  const approve = useCallback(() => {
    onAnswer({ kind: 'approve' });
    setEditor(null);
    setSelection(null);
    dispatch({ t: 'clear' });
  }, [onAnswer]);

  useEffect(() => {
    if (!waiting) return;
    const onKey = (event: KeyboardEvent): void => {
      if (isTyping(event.target)) return;
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        dispatch({ t: 'undo' });
        return;
      }
      // Approving stays a click; the shortcut only sends what was collected.
      if (meta && event.key === 'Enter') {
        if (draft.present.length === 0) return;
        event.preventDefault();
        send();
        return;
      }
      if (event.key === 'Escape') {
        if (editor !== null) setEditor(null);
        else setSelection(null);
        return;
      }
      if (selection === null || meta || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'c') act.openNote(selection.t === 'node' ? nodeKey(selection.id) : edgeKey(selection.i));
      else if (selection.t === 'node' && key === 'a' && !isAsk(selection.id) && view === 'plan') act.openAsk(selection.id);
      else if (selection.t === 'node' && (key === 'backspace' || key === 'delete') && isAsk(selection.id)) act.remove(selection.id);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [waiting, draft.present.length, selection, editor, act, send, view]);

  const tools = waiting && view === 'plan';
  const select = useCallback((next: FlowSelection | null) => {
    setSelection(next);
    setEditor(null);
  }, []);
  return (
    <div className={`pf-canvas${barPhase === null ? '' : ' has-bar'}`} data-testid="plan-flow">
      <Canvas
        key={`${plan.id}@${plan.version}:${direction}`}
        plan={plan} flow={flow} view={view} direction={direction} hoverStep={hoverStep ?? railStep}
        draft={dv} tools={tools} selection={selection} onSelect={select} editor={editor} act={act}
        railOpen={railOpen} bar={barPhase !== null}
      />
      <div className="pf-float pf-row">
        <LayoutMenu settings={{ ...DEFAULT_LAYOUT, direction }} fields={['direction']} onChange={(next) => onDirection(next.direction)} />
        <div className="pf-seg">
          <button type="button" className={view === 'now' ? 'on' : ''} onClick={() => onView('now')}>Now</button>
          <button type="button" className={view === 'plan' ? 'on' : ''} onClick={() => onView('plan')}>After the plan</button>
        </div>
        <div className={`pf-impact${view === 'now' ? ' off' : ''}`}>
          {stats.created > 0 && <span className="pf-stat create"><b>{stats.created}</b> new</span>}
          {stats.modified > 0 && <span className="pf-stat modify"><b>{stats.modified}</b> modified</span>}
          {stats.removed > 0 && <span className="pf-stat delete"><b>{stats.removed}</b> removed</span>}
          <span className="pf-stat"><b>{stats.links}</b> new links</span>
          <span className="pf-stat"><b>{stats.files}</b> files</span>
          {dv.asks.length > 0 && <span className="pf-stat ask"><b>{dv.asks.length}</b> requested</span>}
        </div>
      </div>
      <SteerRail plan={plan} flow={flow} open={railOpen} onToggle={() => onRail(!railOpen)} onHover={setRailStep} />
      {selection !== null && (
        <FlowDetails
          plan={plan} flow={flow} selection={selection} view={view} onClose={() => select(null)}
          steer={{ tools, draft: dv, onNote: act.openNote, onAsk: act.openAsk, onRemove: act.remove }}
        />
      )}
      {barPhase !== null && (
        <SteerBar
          phase={barPhase} version={plan.version} steps={plan.steps.length} files={stats.files}
          items={items} canUndo={draft.past.length > 0} text={text}
          onUndo={() => dispatch({ t: 'undo' })} onReset={() => dispatch({ t: 'clear' })} onRemove={(index) => dispatch({ t: 'remove', index })}
          onSend={send} onApprove={approve}
        />
      )}
    </div>
  );
}

export function PlanFlowView({ plan, flow, hoverStep, onAnswer }: { plan: PlanView; flow: PlanFlow; hoverStep: string | null; onAnswer: (answer: PlanAnswer) => void }) {
  const [view, setView] = useState<FlowView>('plan');
  const [direction, setDirection] = useState<Direction>(() => loadFlowDirection(window.localStorage));
  const [railOpen, setRailOpen] = useState(true);
  const changeDirection = (next: Direction): void => {
    setDirection(next);
    saveFlowDirection(window.localStorage, next);
  };
  return (
    <Workspace
      key={`${plan.id}@${plan.version}`}
      plan={plan} flow={flow} hoverStep={hoverStep} onAnswer={onAnswer}
      view={view} onView={setView} direction={direction} onDirection={changeDirection} railOpen={railOpen} onRail={setRailOpen}
    />
  );
}
