import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { PlanFlowNode, PlanFlowNodeKind } from '@ide/protocol';
import { Icon } from '../layout/Icon';
import { handlePositions, type Direction } from '../map/layout-settings';
import type { FlowView, NodePhase, StepPhase } from './flow-model';
import { KIND_ACCENT, KIND_ICON, OP_CLASS, STATE_TAG } from './flow-style';
import { Chip, Pop, Tool } from './SteerControls';
import { isAsk } from './steer';

const POSITION = { left: Position.Left, right: Position.Right, top: Position.Top, bottom: Position.Bottom };
const ASK_ACCENT = '#b392f0';

export function KindIcon({ kind }: { kind: PlanFlowNodeKind }) {
  return <svg className="pf-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" dangerouslySetInnerHTML={{ __html: KIND_ICON[kind] }} />;
}

export interface CardActions {
  note: () => void;
  ask: () => void;
  remove: () => void;
  saveNote: (text: string) => void;
  saveAsk: (text: string) => void;
  cancel: () => void;
}

// What the user steers on this card while the plan waits for an answer.
export interface CardSteer {
  tools: boolean;
  note: string | undefined;
  editor: 'note' | 'ask' | null;
  actions: CardActions;
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
  steer: CardSteer;
}

export type FlowCardNode = Node<FlowCardData, 'card'>;

export function FlowCard({ data }: NodeProps<FlowCardNode>) {
  const { node, view, phase, badges, direction, hot, dim, selected, steer } = data;
  const ask = isAsk(node.id);
  const hidden = view === 'now' && node.state === 'create';
  const state = view === 'plan' || node.state === 'create' ? node.state : 'existing';
  const handles = handlePositions(direction);
  const first = node.files[0];
  const more = node.files.length - 1;
  const cls = ['pf-card', `st-${state}`, `run-${phase}`, hidden && 'hidden', hot && 'hot', dim && 'dim', selected && 'selected', ask && 'ask'].filter(Boolean).join(' ');
  const tag = ask ? 'ASK' : view === 'plan' && node.state !== 'existing' ? STATE_TAG[node.state] : null;
  const { note, editor, actions } = steer;
  return (
    <div className={cls} style={{ ['--acc' as string]: ask ? ASK_ACCENT : KIND_ACCENT[node.kind] }} data-testid={`flow-node-${node.id}`} data-state={node.state} data-phase={phase} data-hidden={hidden}>
      <Handle type="target" position={POSITION[handles.target]} />
      {steer.tools && view === 'plan' && !hidden && (
        <div className={`pf-tools ${direction === 'DOWN' || direction === 'UP' ? 'side' : 'top'} nodrag nopan`} onClick={(event) => event.stopPropagation()}>
          <Tool tip={note === undefined ? 'Comment' : 'Edit comment'} kbd="C" icon="comment" on={note !== undefined} onClick={actions.note} />
          {ask ? <Tool tip="Remove request" kbd="⌫" icon="close" danger onClick={actions.remove} /> : <Tool tip="Add a part after this" kbd="A" icon="plus" onClick={actions.ask} />}
        </div>
      )}
      {view === 'plan' && badges.length > 0 && (
        <span className="step-badges">
          {badges.map((badge) => (
            <span key={badge.n} className={`step-badge ${badge.phase === 'proposed' ? '' : badge.phase}`}>{badge.phase === 'done' ? '✓' : badge.n}</span>
          ))}
        </span>
      )}
      <div className="pf-head">
        {ask ? <Icon name="plus" size={15} /> : <KindIcon kind={node.kind} />}
        <span className="pf-title">{node.title}</span>
        {tag !== null && <span className={`pf-tag ${ask ? 'ask' : node.state}`}>{tag}</span>}
      </div>
      <div className="pf-sub">{node.sub}</div>
      <div className="pf-file">
        {ask ? (
          <span className="pf-quiet">the agent will pick the files</span>
        ) : view === 'plan' && first ? (
          <>
            <b className={OP_CLASS[first.op]}>{first.op}</b> {first.path}
            {more > 0 && <em> +{more}</em>}
          </>
        ) : (
          <span className="pf-quiet">{node.files.length === 0 ? 'unchanged' : 'existing code'}</span>
        )}
      </div>
      {note !== undefined && view === 'plan' && !hidden && (
        <div className="pf-chips">
          <Chip icon="comment" title={note}>{note}</Chip>
        </div>
      )}
      {editor === 'note' && <Pop label={`Comment on ${node.title}`} placeholder="What should the agent know or do differently?" initial={note ?? ''} action="Save" onSave={actions.saveNote} onCancel={actions.cancel} />}
      {editor === 'ask' && <Pop label={`Add after ${node.title}`} placeholder="What should be added here? e.g. validate the email domain" action="Add" onSave={actions.saveAsk} onCancel={actions.cancel} />}
      <Handle type="source" position={POSITION[handles.source]} />
    </div>
  );
}
