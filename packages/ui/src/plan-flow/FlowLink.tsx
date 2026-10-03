import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';
import type { PlanFlowEdge } from '@ide/protocol';
import type { FlowView, NodePhase } from './flow-model';

export interface FlowLinkData extends Record<string, unknown> {
  edge: PlanFlowEdge;
  view: FlowView;
  phase: NodePhase;
  test: boolean;
  hot: boolean;
  dim: boolean;
}

export type FlowLinkEdge = Edge<FlowLinkData, 'link'>;

export function FlowLink({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps<FlowLinkEdge>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35 });
  const { edge, view, phase, test, hot, dim } = data!;
  const hidden = view === 'now' && edge.state === 'new';
  const shown = view === 'now' ? 'existing' : edge.state;
  const cls = ['pf-edge', `ed-${shown}`, `run-${phase}`, test && 'test', hidden && 'hidden', hot && 'hot', dim && 'dim'].filter(Boolean).join(' ');
  const labelled = !hidden && edge.label !== '' && (edge.state === 'new' || hot);
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={cls} />
      {labelled && (
        <EdgeLabelRenderer>
          <div
            className={`pf-elabel ed-${shown} run-${phase}${hot ? ' hot' : ''}${dim ? ' dim' : ''}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {edge.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
