import { Icon } from '../layout/Icon';
import type { Tally } from './review-flow';

interface Props {
  tally: Tally;
  unsentComments: number;
  onRequest: () => void;
  onAcceptPlan?: () => void;
  onContinue: () => void;
  onExit: () => void;
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

export function ReviewFinish({ tally, unsentComments, onRequest, onAcceptPlan, onContinue, onExit }: Props) {
  if (tally.total === 0) {
    return (
      <div className="rv-finish" role="status">
        <Icon name="file-kind" size={26} />
        <h2>Nothing to review</h2>
        <p>Changes the agent makes show up here, grouped by plan step.</p>
        <div className="rv-finish-actions"><button className="rv-btn primary" onClick={onExit}>Back to the map</button></div>
      </div>
    );
  }
  const clean = tally.accepted === tally.total;
  if (tally.open > 0) {
    return (
      <div className="rv-finish" role="status">
        <span className="rv-finish-check pending"><Icon name="file-kind" size={28} /></span>
        <h2>{plural(tally.open, 'file needs', 'files need')} a decision</h2>
        <p>{tally.open === 1 ? 'It was' : 'They were'} changed after your last decision, or {tally.open === 1 ? 'is' : 'are'} not reviewed yet.</p>
        <div className="rv-finish-actions">
          <button className="rv-btn primary" onClick={onContinue}>Continue the review</button>
          <button className="rv-btn" onClick={onExit}>Back to the map</button>
        </div>
      </div>
    );
  }
  return (
    <div className="rv-finish" role="status">
      <span className={`rv-finish-check${clean ? ' clean' : ''}`}><Icon name="check" size={30} /></span>
      <h2>{clean ? 'All changes accepted' : unsentComments > 0 ? 'Ready to send your comments' : 'Review settled'}</h2>
      <p>
        {clean
          ? `${plural(tally.total, 'file', 'files')} reviewed. Nothing is waiting for you.`
          : unsentComments > 0
            ? `${plural(unsentComments, 'comment', 'comments')} will go to the agent in one message.`
            : tally.requested > 0
              ? `${plural(tally.requested, 'file is', 'files are')} with the agent. ${tally.requested === 1 ? 'It comes' : 'They come'} back here when the agent edits ${tally.requested === 1 ? 'it' : 'them'}.`
              : 'Every file has a decision.'}
      </p>
      <dl className="rv-finish-stats">
        <div className="accepted"><dd>{tally.accepted}</dd><dt>Accepted</dt></div>
        <div className="requested"><dd>{tally.requested}</dd><dt>Sent back</dt></div>
        <div className="reverted"><dd>{tally.reverted}</dd><dt>Reverted</dt></div>
      </dl>
      <div className="rv-finish-actions">
        {unsentComments > 0 && <button className="rv-btn primary" onClick={onRequest}><Icon name="send" size={14} />Request changes<b>{unsentComments}</b></button>}
        {clean && onAcceptPlan && <button className="rv-btn primary" onClick={onAcceptPlan} title="Closes the plan. The agent's next write is denied until it proposes a new plan.">Accept plan</button>}
        <button className={`rv-btn${unsentComments > 0 || (clean && onAcceptPlan) ? '' : ' primary'}`} onClick={onExit}>Back to the map</button>
      </div>
    </div>
  );
}
