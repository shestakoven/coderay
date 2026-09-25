import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { MapFlowNode } from './layout';

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');

export function ComponentNode({ data, selected }: NodeProps<MapFlowNode>) {
  return (
    <div className={classes('node', 'component', data.expanded && 'expanded', data.stale && 'stale', selected && 'selected')}>
      <Handle type="target" position={Position.Left} />
      <div className="title">{data.label}</div>
      {data.summary && (
        <div className="summary" title={data.summary}>
          {data.summary}
        </div>
      )}
      <div className="meta">
        {data.fileCount} files {data.expanded ? '▾' : '▸'}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function FileNode({ data, selected }: NodeProps<MapFlowNode>) {
  return (
    <div className={classes('node', 'file', data.parseError && 'error', selected && 'selected')}>
      <Handle type="target" position={Position.Left} />
      <div className="title">
        {data.parseError ? '⚠ ' : ''}
        {data.label}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const nodeTypes = { component: ComponentNode, file: FileNode };
