import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { PlanFlowNode, PlanFlowNodeKind } from '@ide/protocol';
import { handlePositions, type Direction } from '../map/layout-settings';
import type { FlowView, NodePhase, StepPhase } from './flow-model';
import { KIND_ACCENT, KIND_ICON, OP_CLASS, STATE_TAG } from './flow-style';

const POSITION = { left: Position.Left, right: Position.Right, top: Position.Top, bottom: Position.Bottom };

export function KindIcon({ kind }: { kind: PlanFlowNodeKind }) {
  return <svg className="pf-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" dangerouslySetInnerHTML={{ __html: KIND_ICON[kind] }} />;
}

export interface FlowCardData extends Record<string, unknown> {
  node: PlanFlowNode;
  view: FlowView;
  phase: NodePhase;
  badges: { n: number; phase: StepPhase }[];
  direction: Direction;
  hot: boolean;
  dim: boolean;
  selected: boolean;
}

export type FlowCardNode = Node<FlowCardData, 'card'>;

export function FlowCard({ data }: NodeProps<FlowCardNode>) {
  const { node, view, phase, badges, direction, hot, dim, selected } = data;
  const hidden = view === 'now' && node.state === 'create';
  const state = view === 'plan' || node.state === 'create' ? node.state : 'existing';
  const handles = handlePositions(direction);
  const first = node.files[0];
  const more = node.files.length - 1;
  const cls = ['pf-card', `st-${state}`, `run-${phase}`, hidden && 'hidden', hot && 'hot', dim && 'dim', selected && 'selected'].filter(Boolean).join(' ');
  return (
    <div className={cls} style={{ ['--acc' as string]: KIND_ACCENT[node.kind] }} data-testid={`flow-node-${node.id}`} data-state={node.state} data-phase={phase} data-hidden={hidden}>
      <Handle type="target" position={POSITION[handles.target]} />
      {view === 'plan' && badges.length > 0 && (
        <span className="step-badges">
          {badges.map((badge) => (
            <span key={badge.n} className={`step-badge ${badge.phase === 'proposed' ? '' : badge.phase}`}>{badge.phase === 'done' ? '✓' : badge.n}</span>
          ))}
        </span>
      )}
      <div className="pf-head">
        <KindIcon kind={node.kind} />
        <span className="pf-title">{node.title}</span>
        {view === 'plan' && node.state !== 'existing' && <span className={`pf-tag ${node.state}`}>{STATE_TAG[node.state]}</span>}
      </div>
      <div className="pf-sub">{node.sub}</div>
      <div className="pf-file">
        {view === 'plan' && first ? (
          <>
            <b className={OP_CLASS[first.op]}>{first.op}</b> {first.path}
            {more > 0 && <em> +{more}</em>}
          </>
        ) : (
          <span className="pf-quiet">{node.files.length === 0 ? 'unchanged' : 'existing code'}</span>
        )}
      </div>
      <Handle type="source" position={POSITION[handles.source]} />
    </div>
  );
}
