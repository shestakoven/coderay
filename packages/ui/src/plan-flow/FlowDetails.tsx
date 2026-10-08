import type { PlanFlow, PlanFlowNode, PlanView } from '@ide/protocol';
import { Icon } from '../layout/Icon';
import { KindIcon } from './FlowCard';
import { connections, rationale, type FlowView } from './flow-model';
import { KIND_ACCENT, KIND_LABEL, OP_CLASS } from './flow-style';
import { edgeKey, isAsk, nodeKey, type DraftView } from './steer';

export type FlowSelection = { t: 'node'; id: string } | { t: 'edge'; i: number };

export interface DetailsSteer {
  tools: boolean;
  draft: DraftView;
  onNote: (target: string) => void;
  onAsk: (after: string) => void;
  onRemove: (id: string) => void;
}

function Action({ icon, label, kbd, on = false, danger = false, onClick }: { icon: 'close' | 'comment' | 'plus'; label: string; kbd: string; on?: boolean; danger?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`pf-act${on ? ' on' : ''}${danger ? ' danger' : ''}`} onClick={onClick}>
      <Icon name={icon} size={13} />
      <span>{label}</span>
      <kbd>{kbd}</kbd>
    </button>
  );
}

export function FlowDetails({ plan, flow, selection, view, steer, onClose }: { plan: PlanView; flow: PlanFlow; selection: FlowSelection; view: FlowView; steer: DetailsSteer; onClose: () => void }) {
  if (selection.t === 'edge') {
    const edge = flow.edges[selection.i];
    if (edge === undefined) return null;
    const from = flow.nodes.find((node) => node.id === edge.from);
    const to = flow.nodes.find((node) => node.id === edge.to);
    const note = steer.draft.notes.get(edgeKey(selection.i));
    const step = plan.steps.find((candidate) => candidate.key === edge.step);
    return (
      <section className="pf-detail" data-testid="flow-details">
        <div className="pf-detail-head">
          <span className="pf-detail-title"><Icon name="link" size={14} /> {edge.label}</span>
          <button type="button" className="pf-x" onClick={onClose} aria-label="Close">{'×'}</button>
        </div>
        <div className="pf-detail-sub">{from?.title} {'→'} {to?.title} {'·'} {edge.state}</div>
        {step && <p className="pf-detail-why">{step.rationale}</p>}
        {note !== undefined && <p className="pf-detail-note"><Icon name="comment" size={12} /> {note}</p>}
        {steer.tools && view === 'plan' && !isAsk(edge.to) && (
          <div className="pf-acts">
            <Action icon="comment" label={note === undefined ? 'Comment' : 'Edit comment'} kbd="C" on={note !== undefined} onClick={() => steer.onNote(edgeKey(selection.i))} />
          </div>
        )}
      </section>
    );
  }
  const node: PlanFlowNode | undefined = flow.nodes.find((candidate) => candidate.id === selection.id);
  if (node === undefined) return null;
  const ask = isAsk(node.id);
  const links = connections(flow, node.id);
  const why = ask ? 'You asked for this on the map. The agent will decide where it lives and how it connects.' : rationale(plan, node);
  const changing = view === 'plan' && node.state !== 'existing';
  const note = steer.draft.notes.get(nodeKey(node.id));
  return (
    <section className="pf-detail" data-testid="flow-details">
      <div className="pf-detail-head">
        <span className="pf-detail-title" style={{ ['--acc' as string]: KIND_ACCENT[node.kind] }}>
          {ask ? <Icon name="plus" size={15} /> : <KindIcon kind={node.kind} />}
          {node.title}
        </span>
        <button type="button" className="pf-x" onClick={onClose} aria-label="Close">{'×'}</button>
      </div>
      <div className="pf-detail-sub">{ask ? 'requested' : KIND_LABEL[node.kind]} {'·'} {changing ? node.state : 'unchanged'}</div>
      {why && <p className="pf-detail-why">{why}</p>}
      {note !== undefined && <p className="pf-detail-note"><Icon name="comment" size={12} /> {note}</p>}
      {steer.tools && view === 'plan' && (
        <div className="pf-acts">
          <Action icon="comment" label={note === undefined ? 'Comment' : 'Edit comment'} kbd="C" on={note !== undefined} onClick={() => steer.onNote(nodeKey(node.id))} />
          {ask ? <Action icon="close" label="Remove request" kbd="⌫" danger onClick={() => steer.onRemove(node.id)} /> : <Action icon="plus" label="Add after" kbd="A" onClick={() => steer.onAsk(node.id)} />}
        </div>
      )}
      {node.files.length > 0 && (
        <ul className="pf-files">
          {node.files.map((file, index) => (
            <li key={index}>
              <b className={OP_CLASS[file.op]}>{file.op}</b>
              <span className="pf-path">{file.path}</span>
              {file.note && <span className="pf-note">{file.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {links.length > 0 && (
        <>
          <div className="pf-detail-label">Connections</div>
          <ul className="pf-links">
            {links.map(({ edge, other, outgoing }, index) => (
              <li key={index} className={edge.state}>
                <span>{outgoing ? '→' : '←'} {other.title}</span>
                <span className="pf-note">{edge.label}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
