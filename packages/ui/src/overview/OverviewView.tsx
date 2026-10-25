import { Handle, Position, ReactFlow, useReactFlow, type NodeProps } from '@xyflow/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BackgroundAiStatus, MapOverview, MapSnapshot } from '@ide/protocol';
import { DetailsAside } from '../layout/DetailsSlot';
import './overview.css';
import { MapBackground, MapControls } from '../map/canvas';
import { allGroupsOpen, focusOf, pruneView, LANE_LABEL, overviewGraph, ownership, revealCenter, shortDir, toggleAllGroups, type OvEdge, type OvNode, type Ownership, type Selection } from './overview-graph';

const SIDES = { l: Position.Left, r: Position.Right, t: Position.Top, b: Position.Bottom } as const;

function Handles() {
  return (
    <>
      {(Object.keys(SIDES) as (keyof typeof SIDES)[]).map((side) => (
        <span key={side}>
          <Handle type="source" id={`s-${side}`} position={SIDES[side]} />
          <Handle type="target" id={`t-${side}`} position={SIDES[side]} />
        </span>
      ))}
    </>
  );
}

function Caret({ open }: { open: boolean }) {
  return (
    <span className="ov-caret" title={open ? 'Collapse' : 'Expand'}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={open ? 'm6 9 6 6 6-6' : 'm9 18 6-6-6-6'} />
      </svg>
    </span>
  );
}

const count = (n: number): string => n.toLocaleString('en-US');

function LaneNode({ data }: NodeProps<OvNode>) {
  return (
    <div className={`ov-lane${data.noise ? ' noise' : ''}`} style={{ ['--acc' as string]: data.accent }}>
      <div className="ov-lane-head">
        <span className="ov-lane-dot" />
        <span className="ov-lane-title">{data.title}</span>
        <span className="ov-lane-meta">{data.subtitle}</span>
      </div>
    </div>
  );
}

function GroupNode({ data, selected }: NodeProps<OvNode>) {
  const cls = ['ov-group', data.open && 'open', data.noise && 'noise', selected && 'selected'].filter(Boolean).join(' ');
  return (
    <div className={cls} style={{ ['--acc' as string]: data.accent }}>
      <Handles />
      <div className="ov-group-head">
        <span className="ov-title">{data.title}</span>
        <span className="ov-count" title={`${count(data.files)} files`}>{count(data.files)}</span>
        <Caret open={data.open} />
      </div>
      <div className="ov-summary">{data.summary}</div>
      <div className="ov-share" title={`${Math.round(data.share * 100)}% of the project's files`}>
        <span style={{ width: `${Math.max(2, Math.round(data.share * 100))}%` }} />
      </div>
      {!data.open && (
        <div className="ov-chips">
          {data.chips.map((chip) => (
            <span key={chip.name} className={`ov-chip${chip.noise ? ' noise' : ''}`}>{chip.name}</span>
          ))}
          {data.more > 0 && <span className="ov-chip more">+{data.more}</span>}
        </div>
      )}
    </div>
  );
}

function ComponentNode({ data, selected }: NodeProps<OvNode>) {
  const cls = ['ov-component', data.open && 'open', data.noise && 'noise', selected && 'selected'].filter(Boolean).join(' ');
  return (
    <div className={cls} style={{ ['--acc' as string]: data.accent }}>
      <Handles />
      <div className="ov-component-head">
        <span className="ov-title">{data.title}</span>
        {data.noise && <span className="ov-tag">vendored</span>}
        <Caret open={data.open} />
      </div>
      <div className="ov-role">{data.subtitle}</div>
      <div className="ov-meta">
        <span className="ov-meter"><span style={{ width: `${Math.max(3, Math.round(data.share * 100))}%` }} /></span>
        {data.meta}
      </div>
    </div>
  );
}

function PartNode({ data, selected }: NodeProps<OvNode>) {
  const cls = ['ov-part', data.noise && 'noise', selected && 'selected'].filter(Boolean).join(' ');
  return (
    <div className={cls} style={{ ['--acc' as string]: data.accent }} title={data.meta}>
      <Handles />
      <div className="ov-part-head">
        <span className="ov-title">{data.title}</span>
        <span className="ov-count" title={`${count(data.files)} files`}>{count(data.files)}</span>
      </div>
      <div className="ov-role">{data.subtitle || data.meta}</div>
      <div className="ov-dir">{data.meta.split(' · ').slice(1).join(' · ')}</div>
    </div>
  );
}

const nodeTypes = { ovlane: LaneNode, ovgroup: GroupNode, ovcomponent: ComponentNode, ovpart: PartNode };

const QUIET_EDGES = 18;
const LABELLED_EDGES = 6;

export function OverviewView({ snapshot, overview, onRebuild }: { snapshot: MapSnapshot; overview: MapOverview; onRebuild: () => void }) {
  const ai = snapshot.status.backgroundAi;
  const [groups, setGroups] = useState<Set<string>>(new Set());
  const [components, setComponents] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<Selection>(null);
  const { fitBounds, fitView, setCenter, getViewport } = useReactFlow();
  const needFit = useRef(true);
  // Until the user moves or opens something, every resize of the pane fits the whole map again.
  const autoFit = useRef(true);
  const pane = useRef<HTMLDivElement>(null);
  const toggled = useRef<string | null>(null);
  const bounds = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const graph = useMemo(() => overviewGraph(overview, { groups, components }), [overview, groups, components]);
  const own = useMemo(() => ownership(overview), [overview]);
  // A new answer can drop groups and parts: forget what no longer exists instead of dimming the whole map.
  useEffect(() => {
    const next = pruneView(own, groups, components, selection);
    if (next.groups !== groups) setGroups(next.groups);
    if (next.components !== components) setComponents(next.components);
    if (next.selection !== selection) setSelection(next.selection);
  }, [own, groups, components, selection]);

  useEffect(() => {
    if (graph.nodes.length === 0) return;
    const top = graph.nodes.filter((n) => !n.data.parent);
    if (needFit.current) {
      needFit.current = false;
      const xs = top.flatMap((n) => [n.position.x, n.position.x + (n.width ?? 0)]);
      const ys = top.flatMap((n) => [n.position.y, n.position.y + (n.height ?? 0)]);
      bounds.current = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
      setTimeout(() => void fitBounds(bounds.current!, { padding: 0.05 }), 60);
      return;
    }
    const id = toggled.current;
    toggled.current = null;
    const node = id ? graph.nodes.find((n) => n.id === id) : undefined;
    if (!node) return;
    const box = pane.current?.querySelector('.react-flow')?.getBoundingClientRect();
    if (!box) return;
    const viewport = getViewport();
    const center = revealCenter({ x: node.position.x, y: node.position.y, width: node.width ?? 0, height: node.height ?? 0 }, viewport, box);
    if (center) setTimeout(() => void setCenter(center.x, center.y, { zoom: viewport.zoom, duration: 220 }), 30);
  }, [graph, fitBounds, setCenter, getViewport]);

  useEffect(() => {
    const element = pane.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (autoFit.current && bounds.current) void fitBounds(bounds.current, { padding: 0.05 });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fitBounds]);

  const focus = useMemo(() => focusOf(selection, graph.nodes, graph.edges), [selection, graph]);
  const quiet = useMemo(() => new Set([...graph.edges].sort((a, b) => (b.data?.count ?? 0) - (a.data?.count ?? 0)).slice(0, QUIET_EDGES).map((e) => e.id)), [graph.edges]);
  const shownNodes = useMemo(
    () =>
      graph.nodes.map((n) => {
        if (n.type === 'ovlane') return n;
        const className = focus ? (focus.nodes.has(n.id) ? 'ov-focus' : focus.context.has(n.id) ? 'ov-context' : 'ov-dim') : '';
        return { ...n, className, selected: selection?.type === 'node' && selection.id === n.id };
      }),
    [graph.nodes, focus, selection],
  );
  const shownEdges = useMemo(() => {
    const all = [...graph.edges, ...(focus?.extra ?? [])];
    const labelled = new Set(
      all
        .filter((e) => !e.data?.short && focus?.edges.has(e.id))
        .sort((a, b) => (b.data?.count ?? 0) - (a.data?.count ?? 0))
        .slice(0, LABELLED_EDGES)
        .map((e) => e.id),
    );
    return all.map((e) => {
      const on = focus?.edges.has(e.id) ?? false;
      const count = e.data?.count ?? 0;
      return {
        ...e,
        hidden: focus ? !on : !quiet.has(e.id),
        label: labelled.has(e.id) ? (e.data?.label ? `${e.data.label} · ${count.toLocaleString('en-US')}` : `${count.toLocaleString('en-US')} imports`) : undefined,
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 4,
        className: on ? 'ov-edge-focus' : '',
      };
    });
  }, [graph.edges, focus, quiet]);

  const toggle = (id: string, kind: 'group' | 'component') => {
    toggled.current = id;
    autoFit.current = false;
    const flip = (set: Set<string>) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    };
    if (kind === 'group') setGroups(flip);
    else setComponents(flip);
  };
  const expandable = (n: OvNode) => n.type === 'ovgroup' || n.type === 'ovcomponent';
  const kindOf = (n: OvNode): 'group' | 'component' => (n.type === 'ovgroup' ? 'group' : 'component');
  const allOpen = allGroupsOpen(overview, groups);
  const stats = useMemo(() => {
    const total = overview.groups.reduce((sum, group) => sum + group.files, 0) || 1;
    const noise = overview.groups.filter((group) => group.noise).reduce((sum, group) => sum + group.files, 0);
    return { components: overview.groups.reduce((sum, group) => sum + group.components.length, 0), noise: Math.round((noise / total) * 100) };
  }, [overview]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelection(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="map c4 ov" ref={pane}>
      <ReactFlow
        nodes={shownNodes}
        edges={shownEdges}
        nodeTypes={nodeTypes}
        onNodeClick={(event, node) => {
          if (node.type === 'ovlane') {
            setSelection(null);
            return;
          }
          setSelection({ type: 'node', id: node.id });
          if (expandable(node) && (event.target as HTMLElement).closest('.ov-caret')) toggle(node.id, kindOf(node));
        }}
        onNodeDoubleClick={(_event, node) => {
          if (expandable(node)) toggle(node.id, kindOf(node));
        }}
        onEdgeClick={(_event, edge) => {
          if (!edge.id.startsWith('w:')) setSelection({ type: 'edge', id: edge.id });
        }}
        onPaneClick={() => setSelection(null)}
        onMoveStart={(event) => {
          if (event) autoFit.current = false;
        }}
        zoomOnDoubleClick={false}
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        nodesDraggable={false}
        nodesConnectable={false}
        elevateNodesOnSelect={false}
        elevateEdgesOnSelect={false}
        elementsSelectable
        deleteKeyCode={null}
        minZoom={0.05}
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
      >
        <MapBackground />
        <MapControls onFit={() => void fitView({ padding: 0.06 })} />
      </ReactFlow>
      <div className="ov-toolbar">
        <button
          onClick={() => {
            toggled.current = null;
            needFit.current = true;
            setComponents(new Set());
            setGroups(toggleAllGroups(overview, groups));
          }}
        >
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
        {/* A rebuild while the background AI is off would only drop the overview it cannot draw again. */}
        <button onClick={onRebuild} disabled={overview.state === 'running' || ai.state === 'off'} title={ai.state === 'off' ? ai.hint : undefined}>Rebuild</button>
        {overview.state === 'running' && <span className="ov-status"><span className="ov-spinner" /> Updating…</span>}
        {overview.state === 'failed' && ai.state !== 'off' && <span className="ov-status warn" title={overview.error ?? undefined}>Update failed</span>}
        {!overview.basedOnCurrentMap && overview.state !== 'running' && overview.state !== 'failed' && (
          <span className="ov-badge" title="The component map changed since this overview was drawn">Out of date</span>
        )}
        <span className="muted">
          {selection ? "Showing only the selection's links · Esc clears" : `${stats.components} components · ${overview.groups.length} groups · ${stats.noise}% vendored`}
        </span>
      </div>
      <OverviewDetails snapshot={snapshot} own={own} selection={selection} edges={[...graph.edges, ...(focus?.extra ?? [])]} />
    </div>
  );
}

export function OverviewPending({ overview, backgroundAi, onRebuild, onOpenSettings }: {
  overview: MapOverview | undefined;
  backgroundAi: BackgroundAiStatus;
  onRebuild: () => void;
  onOpenSettings: () => void;
}) {
  const state = overview?.state ?? 'waiting';
  return (
    <div className="map c4 ov ov-empty">
      <div className="ov-empty-card">
        {state === 'waiting' && overview?.error ? (
          <>
            <h2>No overview for this map</h2>
            <p className="muted">{overview.error}</p>
          </>
        ) : backgroundAi.state === 'off' ? (
          <>
            <h2>No overview while the background AI is off</h2>
            <p className="muted">{backgroundAi.hint}</p>
            <button onClick={onOpenSettings}>Open Settings</button>
          </>
        ) : state === 'failed' ? (
          <>
            <h2>Could not build the overview</h2>
            <p className="muted">{overview?.error}</p>
            <button onClick={onRebuild}>Try again</button>
          </>
        ) : state === 'waiting' ? (
          <>
            <h2>No overview yet</h2>
            <p className="muted">The overview is built from the component map once it has at least three components.</p>
          </>
        ) : (
          <>
            <div className="ov-empty-title">
              <span className="ov-spinner" />
              <h2>Sorting components into domains…</h2>
            </div>
            <p className="muted">Grouping the components into domains and naming their parts.</p>
            <p className="muted small">Usually under two minutes; the result is kept for this map.</p>
          </>
        )}
      </div>
    </div>
  );
}

function linkRows(rows: { id: string; count: number; label: string }[], name: (id: string) => string) {
  return (
    <ul className="ov-links">
      {rows.map((row) => (
        <li key={row.id}>
          <span>{name(row.id)}</span>
          {row.label && <span className="muted"> · {row.label}</span>}
          <span className="ov-link-count">{row.count.toLocaleString('en-US')}</span>
        </li>
      ))}
    </ul>
  );
}

function OverviewDetails({ snapshot, own, selection, edges }: { snapshot: MapSnapshot; own: Ownership; selection: Selection; edges: OvEdge[] }) {
  const name = (id: string): string => own.groupById.get(id)?.name ?? own.componentById.get(id)?.name ?? own.partById.get(id)?.name ?? id;
  if (!selection) return null;
  if (selection.type === 'edge') {
    const edge = edges.find((e) => e.id === selection.id);
    if (!edge) return null;
    return (
      <DetailsAside>
        <h2>
          {name(edge.source)} → {name(edge.target)}
        </h2>
        <p className="muted">{edge.data?.count.toLocaleString('en-US')} imports{edge.data?.label ? ` · ${edge.data.label}` : ''}</p>
      </DetailsAside>
    );
  }
  const links = (direction: 'out' | 'in') =>
    edges
      .filter((e) => (direction === 'out' ? e.source === selection.id : e.target === selection.id))
      .map((e) => ({ id: direction === 'out' ? e.target : e.source, count: e.data?.count ?? 0, label: e.data?.label ?? '' }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  const outgoing = links('out');
  const incoming = links('in');
  const linkSections = (
    <>
      {outgoing.length > 0 && (
        <>
          <h3>Depends on</h3>
          {linkRows(outgoing, name)}
        </>
      )}
      {incoming.length > 0 && (
        <>
          <h3>Used by</h3>
          {linkRows(incoming, name)}
        </>
      )}
    </>
  );
  const group = own.groupById.get(selection.id);
  if (group) {
    return (
      <DetailsAside>
        <h2>{group.name}</h2>
        <p className="muted">
          {LANE_LABEL[group.lane]} · {group.components.length} components · {group.files.toLocaleString('en-US')} files
        </p>
        {group.summary && <p className="summary">{group.summary}</p>}
        <h3>Components</h3>
        <ul className="ov-links">
          {group.components.map((component) => (
            <li key={component.id}>
              <span>{component.name}</span>
              {component.role && <span className="muted"> · {component.role}</span>}
              <span className="ov-link-count">{component.files.toLocaleString('en-US')}</span>
            </li>
          ))}
        </ul>
        {linkSections}
      </DetailsAside>
    );
  }
  const component = own.componentById.get(selection.id);
  if (component) {
    const mapped = snapshot.components.find((c) => c.id === component.id);
    return (
      <DetailsAside>
        <h2>{component.name}</h2>
        <p className="muted">
          {component.role} · {component.files.toLocaleString('en-US')} files{component.langs.length > 0 ? ` · ${component.langs.join(', ')}` : ''}
        </p>
        {mapped?.summary && <p className="summary">{mapped.summary}</p>}
        <h3>Parts</h3>
        <ul className="ov-links">
          {component.parts.map((part) => (
            <li key={part.id}>
              <span className={part.noise ? 'muted' : ''}>{part.name}</span>
              <span className="ov-link-count">{part.files.toLocaleString('en-US')}</span>
            </li>
          ))}
        </ul>
        {linkSections}
      </DetailsAside>
    );
  }
  const part = own.partById.get(selection.id);
  if (part) {
    const holder = own.componentById.get(own.componentOfPart.get(part.id) ?? '');
    return (
      <DetailsAside>
        <h2>{part.name}</h2>
        <p className="muted">
          Part of {holder?.name} · {part.files.toLocaleString('en-US')} files{part.noise ? ' · vendored or generated' : ''}
        </p>
        {part.summary && <p className="summary">{part.summary}</p>}
        <h3>Folders</h3>
        <ul>
          {part.dirs.map((dir) => (
            <li key={dir} title={dir}>
              <code>{shortDir(dir)}</code>
            </li>
          ))}
        </ul>
        {linkSections}
      </DetailsAside>
    );
  }
  return null;
}
