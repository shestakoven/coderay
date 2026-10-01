import { Handle, Position, useStore, type NodeProps } from '@xyflow/react';
import { useContext } from 'react';
import { nodeStateClass } from '../history/history-state';
import { changeLine } from '../history/timeline-state';
import { PendingCountsContext, usePlanOverlay } from '../plan/overlay';
import { StepBadges } from '../plan/StepBadges';
import type { MapFlowNode } from './layout';

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');

// Below this zoom node text is unreadable, so components switch to a title-only view whose text scales up.
const FAR_ZOOM = 0.75;
const farZoom = (state: { transform: [number, number, number] }): number => (state.transform[2] < FAR_ZOOM ? Math.max(0.1, Math.round(state.transform[2] * 20) / 20) : 1);

export function ComponentNode({ id, data, selected }: NodeProps<MapFlowNode>) {
  const mark = usePlanOverlay().marks.components.get(id);
  const pending = useContext(PendingCountsContext).get(id);
  const { changes, highlight } = usePlanOverlay();
  const changed = changes.get(id);
  const zoom = useStore(farZoom);
  return (
    <div style={zoom < 1 ? ({ '--zoom': zoom } as React.CSSProperties) : undefined} className={classes('node', 'component', zoom < 1 && 'far', changed && nodeStateClass(changed.states), highlight.has(id) && 'highlight', data.expanded && 'expanded', data.stale && 'stale', mark && 'in-plan', selected && 'selected')}>
      <Handle type="target" position={Position.Left} />
      {mark && <StepBadges steps={mark.steps} />}
      {pending && <span className="pending-badge" title="Waiting for your answer">{pending}</span>}
      <div className="title">{data.label}</div>
      {data.summary && (
        <div className="summary" title={data.summary}>
          {data.summary}
        </div>
      )}
      <div className="meta">
        {data.fileCount} files {data.expanded ? '▾' : '▸'}
        {mark && (
          <span className="plan-meta">
            {' · '}
            {mark.whole ? 'whole component in scope' : `${mark.files.size} in scope`}
            {mark.creates ? ` · +${mark.creates} new` : ''}
          </span>
        )}
        {changed && <span className="change-line"> · {changeLine(changed)}</span>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function FileNode({ id, data, selected }: NodeProps<MapFlowNode>) {
  const steps = usePlanOverlay().marks.files.get(id.startsWith('new:') ? id.slice('new:'.length) : id) ?? [];
  const pending = useContext(PendingCountsContext).get(id);
  const { changes, highlight } = usePlanOverlay();
  const changed = changes.get(id);
  return (
    <div className={classes('node', 'file', changed && nodeStateClass(changed.states), highlight.has(id) && 'highlight', data.parseError && 'error', data.ghost && 'ghost', steps.length > 0 && 'in-plan', selected && 'selected')}>
      <Handle type="target" position={Position.Left} />
      <StepBadges steps={steps} compact />
      {pending && <span className="pending-badge" title="Waiting for your answer">{pending}</span>}
      <div className="title">
        {data.parseError ? '⚠ ' : ''}
        {data.ghost ? '+ ' : ''}
        {data.label}
        {changed && <span className="change-line"> {changeLine(changed)}</span>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const nodeTypes = { component: ComponentNode, file: FileNode };
