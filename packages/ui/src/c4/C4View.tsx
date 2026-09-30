import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import ELK from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { C4Model, MapSnapshot } from '@ide/protocol';
import type { NodeState } from '../history/history-state';
import { c4Graph, c4RootGraph, layoutC4, type C4EdgeData, type C4FlowNode } from './c4-graph';
import { focusOf, type Selection } from './focus';
import { c4NodePlans, componentCard, locateComponent, type NodePlan } from '../plan/c4-marks';
import { nodeStateClass } from '../history/history-state';
import { markCounts } from '../history/dialog-state';
import { PendingCountsContext, usePlanOverlay } from '../plan/overlay';
import { PromptPopover } from '../plan/PromptPopover';
import { promptTarget } from '../plan/prompt-text';
import { StepBadges } from '../plan/StepBadges';

const elk = new ELK({ workerUrl: elkWorkerUrl });

const ICONS: Record<string, string> = {
  person: '<circle cx="8" cy="5" r="3" fill="currentColor"/><path d="M2 15c0-3.3 2.7-5 6-5s6 1.7 6 5z" fill="currentColor"/>',
  web: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 5.5h13"/>',
  api: '<path d="M5 4L1.5 8 5 12M11 4l3.5 4-3.5 4"/>',
  worker: '<circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
  db: '<ellipse cx="8" cy="3.5" rx="5.5" ry="2"/><path d="M2.5 3.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2"/>',
  bucket: '<path d="M2 4h12l-1.5 10h-9z"/><ellipse cx="8" cy="4" rx="6" ry="1.5"/>',
  queue: '<rect x="1.5" y="5" width="3.5" height="6"/><rect x="6.25" y="5" width="3.5" height="6"/><rect x="11" y="5" width="3.5" height="6"/>',
  ai: '<path d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6z" fill="currentColor"/>',
  doc: '<path d="M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3"/>',
  globe: '<circle cx="8" cy="8" r="6.5"/><path d="M1.5 8h13M8 1.5c2 2 2 11 0 13M8 1.5c-2 2-2 11 0 13"/>',
  mail: '<rect x="1.5" y="3.5" width="13" height="9" rx="1"/><path d="M1.5 4.5l6.5 5 6.5-5"/>',
  box: '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/>',
  plug: '<path d="M5.5 1.5v3.5M10.5 1.5v3.5M3.5 5h9v2.5a4.5 4.5 0 0 1-9 0zM8 12v2.5"/>',
  stack: '<rect x="2.5" y="6" width="11" height="7.5" rx="1.5"/><path d="M4 4h8M5.5 2h5"/>',
};

function Icon({ name }: { name: string }) {
  return <svg className="c4-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" dangerouslySetInnerHTML={{ __html: ICONS[name] ?? ICONS.box! }} />;
}

const NodePlansContext = createContext<Map<string, NodePlan>>(new Map());
interface NodeChange { states: NodeState[]; added: number; removed: number; files: number }
const NodeChangesContext = createContext<Map<string, NodeChange>>(new Map());

function C4Card({ id, data, selected }: NodeProps<C4FlowNode>) {
  const plan = useContext(NodePlansContext).get(id);
  const pending = useContext(PendingCountsContext).get(id);
  const changed = useContext(NodeChangesContext).get(id);
  const cls = ['c4-card', data.kind, data.external && 'external', data.dim && 'dim', data.root && 'root', data.expanded && 'expanded', data.warn && 'warn', data.slim && 'slim', plan && 'in-plan', selected && 'selected'].filter(Boolean).join(' ');
  const planLine = plan && !data.expanded ? `${plan.line}${plan.creates ? ` · +${plan.creates} new` : ''}` : null;
  return (
    <div className={cls} style={{ ['--acc' as string]: data.accent }}>
      <Handle type="target" position={Position.Left} />
      {plan && <StepBadges steps={plan.steps} />}
      {pending && <span className="pending-badge" title="Waiting for your answer">{pending}</span>}
      <div className="c4-title">
        <Icon name={data.icon} />
        <span>{data.title}</span>
        {(data.kind === 'container' || data.kind === 'group') && !data.root && !data.dim && <span className="c4-caret">{data.expanded ? '▾' : '▸'}</span>}
      </div>
      <div className="c4-sub">{data.subtitle}</div>
      {changed && <div className="c4-detail change-line">+{changed.added} {'\u2212'}{changed.removed} {'\u00b7'} {changed.files} file{changed.files === 1 ? '' : 's'}</div>}
      {planLine ? <div className="c4-detail c4-plan-line">{planLine}</div> : data.detail && <div className="c4-detail">{data.detail}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { person: C4Card, container: C4Card, c4group: C4Card, external: C4Card, component: C4Card, shared: C4Card };


const expandable = (node: C4FlowNode) => node.type === 'c4group' || node.type === 'container';

export function C4View({ snapshot, model }: { snapshot: MapSnapshot; model: C4Model }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<C4FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<C4EdgeData>>([]);
  const moved = useRef(new Map<string, { x: number; y: number }>());
  const [movedCount, setMovedCount] = useState(0);
  const [resetKey, setResetKey] = useState(0);
  const { fitBounds, setCenter, getZoom } = useReactFlow();
  // Fit every new layout until the user moves, drags or opens something.
  const needFit = useRef(true);
  const graph = useMemo(() => (root ? c4RootGraph(snapshot, model, root, expanded) : c4Graph(snapshot, model, expanded)), [snapshot, model, expanded, root]);
  const openRoot = (id: string | null) => {
    needFit.current = true;
    moved.current.clear();
    setMovedCount(0);
    setMenu(null);
    setSelection(null);
    setExpanded(null);
    setRoot(id);
  };
  const signature = useMemo(() => JSON.stringify(graph), [graph]);

  useEffect(() => {
    let cancelled = false;
    layoutC4(graph, elk).then(
      (layout) => {
        if (cancelled) return;
        setNodes(layout.nodes.map((n) => (!n.parentId && moved.current.has(n.id) ? { ...n, position: moved.current.get(n.id)! } : n)));
        setEdges(layout.edges);
        const top = layout.nodes.filter((n) => !n.parentId).map((n) => (moved.current.has(n.id) ? { ...n, position: moved.current.get(n.id)! } : n));
        if (needFit.current) {
          const xs = top.flatMap((n) => [n.position.x, n.position.x + (n.width ?? 0)]);
          const ys = top.flatMap((n) => [n.position.y, n.position.y + (n.height ?? 0)]);
          const bounds = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
          setTimeout(() => void fitBounds(bounds, { padding: 0.08 }), 30);
        } else if (expanded) {
          const node = top.find((n) => n.id === expanded);
          if (node) {
            const zoom = getZoom();
            const pane = document.querySelector('.c4 .react-flow')?.getBoundingClientRect();
            const visibleHeight = (pane?.height ?? 600) / zoom;
            const width = node.width ?? 0;
            const height = node.height ?? 0;
            const y = height > visibleHeight - 40 ? node.position.y + visibleHeight / 2 - 20 : node.position.y + height / 2;
            setTimeout(() => void setCenter(node.position.x + width / 2, y, { zoom, duration: 200 }), 30);
          }
        }
      },
      (error: unknown) => console.error('c4 layout failed', error),
    );
    return () => {
      cancelled = true;
    };
  }, [signature, resetKey, setNodes, setEdges, fitBounds, setCenter, getZoom]);

  const focus = useMemo(() => focusOf(selection, nodes, edges), [selection, nodes, edges]);
  const overlay = usePlanOverlay();
  const nodePlans = useMemo(() => c4NodePlans(nodes, model, overlay.marks), [nodes, model, overlay.marks]);
  const nodeIds = useMemo(() => new Set(nodes.map((node) => node.id)), [nodes]);
  const promptTargetId = overlay.prompt ? promptTarget(overlay.prompt)?.componentId ?? null : null;
  const promptNode = promptTargetId ? locateComponent(promptTargetId, model, { expanded: root ? null : expanded, root, nodeIds }).node : null;
  const pendingCounts = useMemo(() => {
    const owner = new Map(snapshot.files.map((file) => [file.path, file.componentId]));
    const place = (componentId: string | null | undefined): string | null =>
      componentId ? locateComponent(componentId, model, { expanded: root ? null : expanded, root, nodeIds }).node : null;
    return markCounts([
      ...[...overlay.eventFiles].map((path) => place(owner.get(path))),
      ...overlay.prompts.map((p) => place(promptTarget(p)?.componentId)),
    ]);
  }, [snapshot.files, model, root, expanded, nodeIds, overlay.eventFiles, overlay.prompts]);
  const nodeChangeMarks = useMemo(() => {
    const marks = new Map<string, NodeChange>();
    const place = (componentId: string): string | null =>
      locateComponent(componentId, model, { expanded: root ? null : expanded, root, nodeIds }).node;
    for (const [componentId, found] of overlay.changes) {
      const node = place(componentId);
      if (!node || !snapshot.components.some((c) => c.id === componentId)) continue;
      const seen = marks.get(node) ?? { states: [], added: 0, removed: 0, files: 0 };
      marks.set(node, {
        states: [...seen.states, ...found.states], added: seen.added + found.added, removed: seen.removed + found.removed, files: seen.files + found.files.length,
      });
    }
    return marks;
  }, [overlay.changes, snapshot.components, model, root, expanded, nodeIds]);
  const shownNodes = useMemo(
    () =>
      nodes.map((n) => {
        const inPlan = nodePlans.has(n.id) || nodes.some((child) => child.parentId === n.id && nodePlans.has(child.id));
        const className = focus
          ? focus.nodes.has(n.id) ? 'c4-focus' : focus.context.has(n.id) ? '' : 'c4-dim'
          : overlay.dimOthers && !inPlan ? 'c4-dim' : '';
        const stateClass = nodeStateClass(nodeChangeMarks.get(n.id)?.states ?? []);
        const withState = `${className} ${stateClass}`.trim();
        const withPrompt = pendingCounts.has(n.id) ? `${withState} oop-target`.trim() : withState;
        return n.className === withPrompt ? n : { ...n, className: withPrompt };
      }),
    [nodes, focus, nodePlans, overlay.dimOthers, pendingCounts, nodeChangeMarks],
  );
  const shownEdges = useMemo(
    () =>
      edges.map((e) => {
        const on = focus?.edges.has(e.id) ?? false;
        const kind = e.data?.kind ?? 'plain';
        const quiet = kind !== 'detail';
        return {
          ...e,
          hidden: focus ? !on : !quiet,
          animated: on,
          label: on ? e.label : undefined,
          className: [e.className, on && 'c4-edge-focus'].filter(Boolean).join(' '),
        };
      }),
    [edges, focus],
  );

  useEffect(() => {
    const componentId = overlay.focus?.componentIds[0];
    if (!componentId) return;
    const target = locateComponent(componentId, model, { expanded: root ? null : expanded, root, nodeIds });
    if (root && target.node?.startsWith('root:')) {
      setSelection({ type: 'node', id: target.node });
      return;
    }
    if (root) setRoot(null);
    const container = model.containers.find((candidate) => candidate.id === target.container);
    if (!container) return;
    needFit.current = false;
    setExpanded(container.id);
    setSelection({ type: 'node', id: componentCard(container, componentId) });
  }, [overlay.focus?.nonce]);

  const toggle = (id: string) => {
    needFit.current = false;
    setExpanded((current) => (current === id ? null : id));
  };

  return (
    <NodePlansContext.Provider value={nodePlans}>
    <NodeChangesContext.Provider value={nodeChangeMarks}>
    <PendingCountsContext.Provider value={pendingCounts}>
    <div className="map c4">
      <ReactFlow
        nodes={shownNodes}
        edges={shownEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(event, node) => {
          setSelection({ type: 'node', id: node.id });
          if (expandable(node) && (event.target as HTMLElement).closest('.c4-caret')) toggle(node.id);
        }}
        onNodeDoubleClick={(_event, node) => {
          if (root) {
            if (node.type === 'container' && node.id !== root) openRoot(node.id);
            else if (node.type === 'c4group') toggle(node.id);
            return;
          }
          if (expandable(node)) toggle(node.id);
        }}
        onNodeContextMenu={(event, node) => {
          event.preventDefault();
          if (node.type !== 'container') return;
          const box = (event.currentTarget as HTMLElement).closest('.c4')?.getBoundingClientRect();
          setMenu({ x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0), id: node.id });
        }}
        onNodeDragStop={(_event, node) => {
          needFit.current = false;
          if (node.parentId) return;
          moved.current.set(node.id, node.position);
          setMovedCount(moved.current.size);
        }}
        onEdgeClick={(_event, edge) => setSelection({ type: 'edge', id: edge.id, ids: edge.data?.linkIds ?? [] })}
        onPaneClick={() => {
          setSelection(null);
          setMenu(null);
        }}
        onMoveStart={(event) => {
          if (event) needFit.current = false;
        }}
        zoomOnDoubleClick={false}
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        nodesDraggable
        nodesConnectable={false}
        deleteKeyCode={null}
        minZoom={0.05}
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} />
        <Controls showInteractive={false} />
        <PromptPopover nodeId={promptNode} />
      </ReactFlow>
      <div className="c4-toolbar">
        <span className="c4-crumbs">
          <button className="link" onClick={() => openRoot(null)} disabled={!root}>
            {snapshot.projectName}
          </button>
          {root && <span> / {model.containers.find((c) => c.id === root)?.name}</span>}
        </span>
        {selection && <span className="muted">Showing only the selection's links · Esc or click the background to clear</span>}
        {movedCount > 0 && (
          <button
            onClick={() => {
              moved.current.clear();
              setMovedCount(0);
              needFit.current = true;
              setResetKey((k) => k + 1);
            }}
          >
            Reset layout
          </button>
        )}
      </div>
      {menu && (
        <div className="c4-menu" style={{ left: menu.x, top: menu.y }}>
          <button onClick={() => openRoot(menu.id)}>Open as root</button>
        </div>
      )}
      <EscapeClears
        onClear={() => {
          if (menu) setMenu(null);
          else if (selection) setSelection(null);
          else if (root) openRoot(null);
        }}
      />
      <C4Details snapshot={snapshot} model={model} selection={selection} />
    </div>
    </PendingCountsContext.Provider>
    </NodeChangesContext.Provider>
    </NodePlansContext.Provider>
  );
}

function EscapeClears({ onClear }: { onClear: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return null;
}

function C4Details({ snapshot, model, selection }: { snapshot: MapSnapshot; model: C4Model; selection: Selection }) {
  if (!selection) {
    if (model.warnings.length === 0 && model.tooling.length === 0) return null;
    return (
      <aside className="details c4-notes">
        {model.tooling.length > 0 && <p className="muted">Tooling (not drawn): {model.tooling.join(', ')}</p>}
        {model.warnings.map((w) => (
          <p key={w} className="warn">{w}</p>
        ))}
      </aside>
    );
  }
  const componentName = (id: string) => snapshot.components.find((c) => c.id === id)?.name ?? (id === 'unassigned' ? 'Unassigned files' : id);
  if (selection.type === 'edge') {
    const links = model.links.filter((l) => selection.ids.includes(l.id));
    return (
      <aside className="details">
        {links.map((l) => (
          <section key={l.id}>
            <h2>
              {nameOf(model, l.from)} → {nameOf(model, l.to)}
            </h2>
            <p className="muted">
              {l.protocol} · {l.strength} evidence sites
            </p>
            <ul>
              {l.evidence.slice(0, 40).map((e) => (
                <li key={`${e.path}:${e.note}`}>
                  <code>{e.path}</code> <span className="muted">{e.note}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </aside>
    );
  }
  const rootComponent = selection.id.startsWith('root:') ? snapshot.components.find((c) => `root:${c.id}` === selection.id) : undefined;
  if (rootComponent) {
    return (
      <aside className="details">
        <h2>{rootComponent.name}</h2>
        {rootComponent.summary && <p className="summary">{rootComponent.summary}</p>}
        {rootComponent.description && <p>{rootComponent.description}</p>}
        {rootComponent.keyFiles.length > 0 && (
          <>
            <h3>Key files</h3>
            <ul>
              {rootComponent.keyFiles.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>
    );
  }
  const container = model.containers.find((c) => c.id === selection.id);
  const members = model.containers.filter((c) => c.group === selection.id);
  const external = model.externals.find((e) => e.id === selection.id);
  const shown = container ?? members[0];
  if (shown) {
    const list = container ? [container] : members;
    return (
      <aside className="details">
        <h2>{container ? container.name : `${members.length} containers from one build`}</h2>
        <p className="muted">
          {shown.role} · {shown.tech}
        </p>
        {list.map((c) => (
          <section key={c.id}>
            {!container && <h3>{c.name}</h3>}
            {c.launch.map((line) => (
              <pre key={line} className="c4-launch">{line}</pre>
            ))}
            {c.entryFiles.length > 0 && <p>Entry: {c.entryFiles.map((p) => <code key={p}>{p} </code>)}</p>}
            {c.entryMissing.length > 0 && <p className="warn">Entry not found: {c.entryMissing.join(', ')}</p>}
          </section>
        ))}
        {container && (
          <>
            <h3>Components ({container.components.length}) · {container.files} files</h3>
            <ul>
              {container.components.map((p) => (
                <li key={p.id}>
                  {componentName(p.id)} <span className="muted">{p.near} near · {p.files} files{p.containers > 1 ? ` · in ${p.containers} containers` : ''}</span>
                </li>
              ))}
            </ul>
            <h3>Evidence</h3>
            <ul>
              {container.evidence.map((e) => (
                <li key={`${e.path}:${e.note}`}>
                  <code>{e.path}</code> <span className="muted">{e.note}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>
    );
  }
  if (external) {
    const users = model.links.filter((l) => l.to === external.id).map((l) => nameOf(model, l.from));
    return (
      <aside className="details">
        <h2>{external.name}</h2>
        <p className="muted">{external.kind} · classified from names only</p>
        <h3>Identifiers</h3>
        <ul>
          {external.identifiers.map((i) => (
            <li key={i}>
              <code>{i}</code>
            </li>
          ))}
        </ul>
        <h3>Used by</h3>
        <p>{users.join(', ')}</p>
      </aside>
    );
  }
  return null;
}

function nameOf(model: C4Model, id: string): string {
  if (id === 'users') return 'Users';
  return model.containers.find((c) => c.id === id)?.name ?? model.externals.find((e) => e.id === id)?.name ?? id;
}
