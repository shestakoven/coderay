import { Handle, Position, type NodeProps } from '@xyflow/react';
import { usePlanOverlay } from '../plan/overlay';
import { StepBadges } from '../plan/StepBadges';
import type { MapFlowNode } from './layout';

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');

export function ComponentNode({ id, data, selected }: NodeProps<MapFlowNode>) {
  const mark = usePlanOverlay().marks.components.get(id);
  return (
    <div className={classes('node', 'component', data.expanded && 'expanded', data.stale && 'stale', mark && 'in-plan', selected && 'selected')}>
      <Handle type="target" position={Position.Left} />
      {mark && <StepBadges steps={mark.steps} />}
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
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function FileNode({ id, data, selected }: NodeProps<MapFlowNode>) {
  const steps = usePlanOverlay().marks.files.get(id.startsWith('new:') ? id.slice('new:'.length) : id) ?? [];
  return (
    <div className={classes('node', 'file', data.parseError && 'error', data.ghost && 'ghost', steps.length > 0 && 'in-plan', selected && 'selected')}>
      <Handle type="target" position={Position.Left} />
      <StepBadges steps={steps} compact />
      <div className="title">
        {data.parseError ? '⚠ ' : ''}
        {data.ghost ? '+ ' : ''}
        {data.label}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const nodeTypes = { component: ComponentNode, file: FileNode };
