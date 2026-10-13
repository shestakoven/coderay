import { getViewportForBounds, MarkerType, ReactFlow, ReactFlowProvider, useReactFlow, useStore, useStoreApi, type Edge, type Node, type Viewport } from '@xyflow/react';
import type { ReviewLinkState } from '@ide/protocol';
import ELK from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../layout/Icon';
import { MapBackground, MapControls } from '../../map/canvas';
import type { Bounds } from '../../map/layout';
import type { Direction } from '../../map/layout-settings';
import { boundsOf, FLOW_NODE_SIZE, type Positions } from '../../plan-flow/flow-layout';
import { useTweened } from '../../plan-flow/use-tweened';
import { placeLabels } from './review-map-labels';
import { fitStep, focusOf, targetKey, type Focus, type MapStep, type MapView, type Target } from './review-map-model';
import { questionFor, type MapQuestion } from './review-map-questions';
import { ReviewMapCard, type ReviewMapCardData, type ReviewMapCardNode } from './ReviewMapCard';
import { linkLabel, ReviewMapLink, type ReviewMapLinkData, type ReviewMapLinkEdge } from './ReviewMapLink';

const elk = new ELK({ workerUrl: elkWorkerUrl });
const nodeTypes = { card: ReviewMapCard };
const edgeTypes = { link: ReviewMapLink };

const COLOR: Record<ReviewLinkState, string> = {
  existing: '#868a91', new: '#73c991', removed: '#f75464', unplanned: '#f2c55c', missing: '#868a91', broken: '#f75464',
};

const PADDING = { right: '56px', bottom: '104px', left: '56px' } as const;
// Above the map: the toolbar's offset and a gap below it; 60 stands in for a toolbar of two rows until it is measured.
const topPadding = (headHeight: number): `${number}px` => `${12 + (headHeight > 0 ? headHeight : 60) + 12}px`;

// The app's Reduce motion setting, which already folds in the system's; the media query only when the app has not said.
function reducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  const app = document.documentElement.dataset.motion;
  if (app !== undefined) return app === 'reduce';
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

// Flagged links pick their label spot first, then new ones; an existing link is labelled only when pointed at.
const LABEL_RANK: Record<ReviewLinkState, number> = { broken: 0, unplanned: 0, missing: 0, removed: 1, new: 2, existing: 3 };

interface Layout {
  shape: string;
  positions: Positions;
}

async function layoutOf(ids: string[], edges: { id: string; from: string; to: string }[], direction: Direction): Promise<Positions> {
  const vertical = direction === 'DOWN' || direction === 'UP';
  const result = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.spacing.nodeNode': vertical ? '56' : '40',
      'elk.layered.spacing.nodeNodeBetweenLayers': vertical ? '100' : '150',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    },
    children: ids.map((id) => ({ id, ...FLOW_NODE_SIZE })),
    edges: edges.map((edge) => ({ id: edge.id, sources: [edge.from], targets: [edge.to] })),
  });
  return new Map((result.children ?? []).map((child) => [child.id, { x: child.x ?? 0, y: child.y ?? 0 }]));
}

export interface ReviewMapCanvasProps {
  view: MapView;
  focus: Focus | null;
  selection: Target | null;
  direction: Direction;
  steps: MapStep[];
  reviewed: ReadonlySet<string>;
  questions: MapQuestion[];
  editing: string | null;
  onSelect: (target: Target | null) => void;
  onAsk: (target: Target) => void;
  onSave: (target: Target, text: string) => void;
  onCancel: () => void;
  onOpenChat: () => void;
  headHeight: number;
}

function Canvas({ view, focus: selectedFocus, selection, direction, steps, reviewed, questions, editing, onSelect, onAsk, onSave, onCancel, onOpenChat, headHeight }: ReviewMapCanvasProps) {
  const padding = useMemo(() => ({ ...PADDING, top: topPadding(headHeight) }), [headHeight]);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [failed, setFailed] = useState(false);
  const [hoverPart, setHoverPart] = useState<string | null>(null);
  const [hoverLink, setHoverLink] = useState<number | null>(null);
  const leavePart = useRef<number | undefined>(undefined);
  const leaveLink = useRef<number | undefined>(undefined);
  const { setViewport } = useReactFlow();
  const store = useStoreApi();

  const ids = useMemo(() => view.parts.map((part) => part.id), [view]);
  // The last viewport the map chose itself: while the camera is still there, a resized canvas is fitted again.
  const autoFit = useRef<Viewport | null>(null);
  const fitTo = useCallback((bounds: Bounds, duration?: number) => {
    const { width, height, minZoom } = store.getState();
    const viewport = getViewportForBounds(bounds, width, height, minZoom, 1, padding);
    autoFit.current = viewport;
    void setViewport(viewport, { duration });
  }, [store, setViewport, padding]);

  const signature = useMemo(() => `${direction}|${ids.join()}|${view.links.map(({ link }) => `${link.from}>${link.to}`).join()}`, [direction, ids, view]);
  useEffect(() => {
    let live = true;
    const edges = view.links.map(({ link, index }) => ({ id: `e${index}`, from: link.from, to: link.to }));
    layoutOf(ids, edges, direction).then(
      (positions) => {
        if (!live) return;
        setLayout({ shape: signature, positions });
        setFailed(false);
      },
      (error: unknown) => {
        console.error('review map layout failed', error);
        if (!live) return;
        setLayout(null);
        setFailed(true);
      },
    );
    return () => { live = false; };
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  const reduced = reducedMotion();
  const laidOut = layout === null ? null : layout.positions;
  const tweened = useTweened(reduced ? null : laidOut);
  const positions = reduced ? laidOut : tweened;
  const destination = useMemo(() => (layout === null || layout.shape !== signature ? null : boundsOf(layout.positions, ids)), [layout, signature, ids]);
  const fitted = useRef('');
  useEffect(() => {
    const step = fitStep(layout?.shape ?? null, signature, fitted.current);
    if (step === 'wait' || step === 'done') return;
    fitted.current = signature;
    if (destination === null) return;
    if (step === 'fit') fitTo(destination, reduced ? 0 : 420);
    // fitView places the first layout; once the canvas has a size, fitting it again to the same place records the camera.
    else if (store.getState().width > 0) fitTo(destination, 0);
  }, [layout, signature, destination, fitTo, reduced, store]);

  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  useEffect(() => {
    if (destination === null || width === 0 || height === 0 || fitted.current !== signature) return;
    const chosen = autoFit.current;
    const [x, y, zoom] = store.getState().transform;
    // The user panned or zoomed since: the camera is theirs.
    if (chosen !== null && (Math.abs(x - chosen.x) > 0.5 || Math.abs(y - chosen.y) > 0.5 || Math.abs(zoom - chosen.zoom) > 0.001)) return;
    fitTo(destination, 0);
  }, [width, height, padding]); // eslint-disable-line react-hooks/exhaustive-deps -- a new layout is fitted by the effect above; this one reacts to the canvas size alone

  useEffect(() => () => {
    window.clearTimeout(leavePart.current);
    window.clearTimeout(leaveLink.current);
  }, []);

  const hoverPartIn = useCallback((id: string | null) => {
    window.clearTimeout(leavePart.current);
    if (id !== null) setHoverPart(id);
    else leavePart.current = window.setTimeout(() => setHoverPart(null), 90);
  }, []);
  const hoverLinkIn = useCallback((index: number | null) => {
    window.clearTimeout(leaveLink.current);
    if (index !== null) setHoverLink(index);
    else leaveLink.current = window.setTimeout(() => setHoverLink(null), 120);
  }, []);

  const titles = useMemo(() => new Map(view.parts.map((part) => [part.id, part.title])), [view]);
  const labelTs = useMemo(
    () => (laidOut === null ? new Map<number, number>() : placeLabels(
      view.links.map(({ link, index }) => ({ index, from: link.from, to: link.to, text: linkLabel(link), rank: LABEL_RANK[link.state] })),
      laidOut, FLOW_NODE_SIZE, direction,
    )),
    [laidOut, view, direction],
  );

  const hovered: Focus | null = useMemo(() => {
    const at = hoverLink === null ? undefined : view.links.find(({ index }) => index === hoverLink);
    if (at !== undefined) return focusOf(view, { t: 'link', from: at.link.from, to: at.link.to });
    return hoverPart === null ? null : focusOf(view, { t: 'part', id: hoverPart });
  }, [view, hoverLink, hoverPart]);
  const focus = hovered ?? selectedFocus;

  const selectedPart = selection?.t === 'part' && titles.has(selection.id) ? selection.id : null;
  const selectedLink = selection?.t === 'link' ? view.links.find(({ link }) => link.from === selection.from && link.to === selection.to)?.index ?? null : null;

  // A part that has no place yet (a newer graph is being laid out) waits instead of flashing in the corner.
  const placed = useMemo(() => view.parts.filter((part) => positions?.has(part.id) ?? false), [view, positions]);
  const placedIds = useMemo(() => new Set(placed.map((part) => part.id)), [placed]);

  const stepByKey = useMemo(() => new Map(steps.map((step) => [step.key, step])), [steps]);

  const cards: ReviewMapCardNode[] = useMemo(
    () => placed.map((part) => {
      const target: Target = { t: 'part', id: part.id };
      return {
        id: part.id,
        type: 'card',
        position: positions?.get(part.id) ?? { x: 0, y: 0 },
        width: FLOW_NODE_SIZE.width,
        height: FLOW_NODE_SIZE.height,
        // Cards have a fixed size; without it every rebuilt node is measured again and its links vanish until the next frame.
        measured: { width: FLOW_NODE_SIZE.width, height: FLOW_NODE_SIZE.height },
        zIndex: selectedPart === part.id || hoverPart === part.id || editing === targetKey(target) ? 20 : undefined,
        data: {
          part,
          badges: part.steps.flatMap((key) => {
            const step = stepByKey.get(key);
            return step === undefined ? [] : [{ n: step.no, outcome: step.outcome }];
          }).sort((a, b) => a.n - b.n),
          direction,
          hot: focus?.parts.has(part.id) ?? false,
          dim: focus !== null && !focus.parts.has(part.id),
          selected: selectedPart === part.id,
          reviewed: part.files.filter((file) => reviewed.has(file.path)).length,
          question: questionFor(questions, target),
          editing: editing === targetKey(target),
          onAsk: () => onAsk(target),
          onSave: (text) => onSave(target, text),
          onCancel,
          onOpenChat,
        } satisfies ReviewMapCardData,
      };
    }),
    [placed, stepByKey, positions, direction, focus, selectedPart, hoverPart, reviewed, questions, editing, onAsk, onSave, onCancel, onOpenChat],
  );

  const edges: ReviewMapLinkEdge[] = useMemo(
    () => view.links.filter(({ link }) => placedIds.has(link.from) && placedIds.has(link.to)).map(({ link, index }) => {
      const target: Target = { t: 'link', from: link.from, to: link.to };
      return {
        id: `e${index}`,
        source: link.from,
        target: link.to,
        type: 'link',
        markerEnd: { type: MarkerType.ArrowClosed, color: COLOR[link.state], width: 14, height: 14 },
        data: {
          link,
          index,
          label: linkLabel(link),
          labelT: labelTs.get(index),
          title: `${titles.get(link.from) ?? link.from} → ${titles.get(link.to) ?? link.to}`,
          hot: focus?.links.has(index) ?? false,
          active: hoverLink === index || selectedLink === index,
          dim: focus !== null && !focus.links.has(index),
          selected: selectedLink === index,
          question: questionFor(questions, target),
          editing: editing === targetKey(target),
          onHover: hoverLinkIn,
          onSelect: () => onSelect(target),
          onAsk: () => onAsk(target),
          onSave: (text) => onSave(target, text),
          onCancel,
        } satisfies ReviewMapLinkData,
      };
    }),
    [view, placedIds, titles, labelTs, focus, hoverLink, selectedLink, questions, editing, hoverLinkIn, onSelect, onAsk, onSave, onCancel],
  );

  if (positions === null) {
    return failed ? (
      <div className="rm-empty" role="alert">
        <Icon name="alert" size={20} />
        <p>The map could not be laid out.</p>
      </div>
    ) : null;
  }
  return (
    <ReactFlow
      fitView
      fitViewOptions={{ padding, maxZoom: 1 }}
      nodes={cards as Node[]}
      edges={edges as Edge[]}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      deleteKeyCode={null}
      selectionKeyCode={null}
      zoomOnDoubleClick={false}
      panOnScroll
      zoomOnScroll={false}
      minZoom={0.3}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, node) => onSelect(selectedPart === node.id ? null : { t: 'part', id: node.id })}
      onEdgeClick={(_, edge) => {
        const at = view.links.find(({ index }) => index === Number(edge.id.slice(1)));
        if (at !== undefined) onSelect({ t: 'link', from: at.link.from, to: at.link.to });
      }}
      onNodeMouseEnter={(_, node) => hoverPartIn(node.id)}
      onNodeMouseLeave={() => hoverPartIn(null)}
      onEdgeMouseEnter={(_, edge) => hoverLinkIn(Number(edge.id.slice(1)))}
      onEdgeMouseLeave={() => hoverLinkIn(null)}
      onPaneClick={() => onSelect(null)}
    >
      <MapBackground />
      <MapControls disabled={destination === null} onFit={() => destination && fitTo(destination)} />
    </ReactFlow>
  );
}

export function ReviewMapCanvas(props: ReviewMapCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
