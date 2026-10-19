import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';
import type { PlanFlowEdge } from '@ide/protocol';
import { Icon } from '../layout/Icon';
import type { FlowView, NodePhase } from './flow-model';
import { Pop, Tool } from './SteerControls';

// What the user steers on this link while the plan waits for an answer.
export interface LinkSteer {
  tools: boolean;
  index: number;
  note: string | undefined;
  editing: boolean;
  active: boolean;
  onHover: (index: number | null) => void;
  onSelect: () => void;
  onNote: () => void;
  onSave: (text: string) => void;
  onCancel: () => void;
}

export interface FlowLinkData extends Record<string, unknown> {
  edge: PlanFlowEdge;
  view: FlowView;
  phase: NodePhase;
  test: boolean;
  ask: boolean;
  hot: boolean;
  dim: boolean;
  selected: boolean;
  steer: LinkSteer;
}

export type FlowLinkEdge = Edge<FlowLinkData, 'link'>;

export function FlowLink({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps<FlowLinkEdge>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35 });
  const { edge, view, phase, test, ask, hot, dim, selected, steer } = data!;
  const hidden = view === 'now' && edge.state === 'new';
  const shown = view === 'now' ? 'existing' : edge.state;
  const cls = ['pf-edge', `ed-${shown}`, `run-${phase}`, test && 'test', ask && 'ask', hidden && 'hidden', hot && 'hot', dim && 'dim', selected && 'sel'].filter(Boolean).join(' ');
  const labelled = !hidden && edge.label !== '' && (edge.state === 'new' || hot || selected || steer.note !== undefined);
  const live = steer.tools && view === 'plan' && (steer.active || steer.editing);
  const classes = `pf-elabel ed-${shown} run-${phase}${ask ? ' ask' : ''}${hot ? ' hot' : ''}${dim ? ' dim' : ''}${selected ? ' sel' : ''}${live ? ' live' : ''}${steer.tools ? ' steer' : ''} nodrag nopan`;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={cls} interactionWidth={steer.tools ? 22 : undefined} />
      {labelled && (
        <EdgeLabelRenderer>
          <div
            className={classes}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onMouseEnter={() => steer.onHover(steer.index)}
            onMouseLeave={() => steer.onHover(null)}
            onClick={(event) => {
              event.stopPropagation();
              steer.onSelect();
            }}
            data-testid={`flow-edge-${steer.index}`}
          >
            <span className="pf-elabel-text">{edge.label}</span>
            {steer.note !== undefined && !live && <Icon name="comment" size={10} />}
            {live && (
              <span className="pf-etools">
                <Tool tip={steer.note === undefined ? 'Comment' : 'Edit comment'} kbd="C" icon="comment" on={steer.note !== undefined} onClick={steer.onNote} />
              </span>
            )}
            {steer.editing && <Pop below label={`Comment on ${edge.label}`} placeholder="What should change about this link?" initial={steer.note ?? ''} action="Save" onSave={steer.onSave} onCancel={steer.onCancel} />}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
