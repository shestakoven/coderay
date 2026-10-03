import type { PlanFlow, PlanFlowNode, PlanView } from '@ide/protocol';
import { KindIcon } from './FlowCard';
import { connections, rationale, type FlowView } from './flow-model';
import { KIND_ACCENT, KIND_LABEL, OP_CLASS } from './flow-style';

export function FlowDetails({ plan, flow, node, view, onClose }: { plan: PlanView; flow: PlanFlow; node: PlanFlowNode; view: FlowView; onClose: () => void }) {
  const links = connections(flow, node.id);
  const why = rationale(plan, node);
  const changing = view === 'plan' && node.state !== 'existing';
  return (
    <section className="pf-detail" data-testid="flow-details">
      <div className="pf-detail-head">
        <span className="pf-detail-title" style={{ ['--acc' as string]: KIND_ACCENT[node.kind] }}>
          <KindIcon kind={node.kind} />
          {node.title}
        </span>
        <button type="button" className="pf-x" onClick={onClose} aria-label="Close">{'×'}</button>
      </div>
      <div className="pf-detail-sub">{KIND_LABEL[node.kind]} {'·'} {changing ? node.state : 'unchanged'}</div>
      {why && <p className="pf-detail-why">{why}</p>}
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
