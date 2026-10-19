import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { ReviewPart, ReviewPartStatus } from '@ide/protocol';
import { Icon } from '../../layout/Icon';
import { handlePositions, type Direction } from '../../map/layout-settings';
import { KindIcon } from '../../plan-flow/FlowCard';
import { KIND_ACCENT } from '../../plan-flow/flow-style';
import { Pop, Tool } from '../../plan-flow/SteerControls';
import type { StepOutcome } from './review-map-model';
import type { MapQuestion } from './review-map-questions';

const POSITION = { left: Position.Left, right: Position.Right, top: Position.Top, bottom: Position.Bottom };

const TAG: Record<ReviewPartStatus, string | null> = { created: 'NEW', modified: 'CHANGED', deleted: 'REMOVED', untouched: null, missing: 'NOT DONE' };
const CLASS: Record<ReviewPartStatus, string> = { created: 'st-create run-done', modified: 'st-modify', deleted: 'st-delete', untouched: 'st-existing', missing: 'rm-missing' };

export interface ReviewMapCardData extends Record<string, unknown> {
  part: ReviewPart;
  badges: { n: number; outcome: StepOutcome }[];
  direction: Direction;
  hot: boolean;
  dim: boolean;
  selected: boolean;
  reviewed: number;
  question: MapQuestion | undefined;
  editing: boolean;
  onAsk: () => void;
  onSave: (text: string) => void;
  onCancel: () => void;
  onOpenChat: () => void;
}

export type ReviewMapCardNode = Node<ReviewMapCardData, 'card'>;

function commonDirectory(paths: string[]): string {
  const dirs = paths.map((path) => path.split('/').slice(0, -1));
  const first = dirs[0];
  if (first === undefined) return '';
  let shared = first.length;
  for (const dir of dirs) {
    let at = 0;
    while (at < shared && at < dir.length && dir[at] === first[at]) at += 1;
    shared = at;
  }
  return first.slice(0, shared).join('/');
}

function subOf(part: ReviewPart): string {
  if (part.files.length === 0) return '';
  const common = commonDirectory(part.files.map((file) => file.path));
  if (common !== '') return common;
  return part.files.length === 1 ? 'project root' : 'several folders';
}

export function ReviewMapCard({ data }: NodeProps<ReviewMapCardNode>) {
  const { part, badges, direction, hot, dim, selected, reviewed, question, editing, onAsk, onSave, onCancel, onOpenChat } = data;
  const handles = handlePositions(direction);
  const tag = part.outside ? 'OUTSIDE PLAN' : TAG[part.status];
  const added = part.files.reduce((sum, file) => sum + file.added, 0);
  const removed = part.files.reduce((sum, file) => sum + file.removed, 0);
  const complete = part.files.length > 0 && reviewed === part.files.length;
  const cls = ['pf-card', CLASS[part.status], part.outside && 'rm-outside', hot && 'hot', dim && 'dim', selected && 'selected'].filter(Boolean).join(' ');
  const asked = question !== undefined && question.sentAt !== null;
  const draft = question !== undefined && !asked ? question.text : '';
  const sub = subOf(part);
  return (
    <div className={cls} style={{ ['--acc' as string]: KIND_ACCENT.module }} data-testid={`review-map-part-${part.id}`} data-status={part.status}>
      <Handle type="target" position={POSITION[handles.target]} />
      <div className={`pf-tools ${direction === 'DOWN' || direction === 'UP' ? 'side' : 'top'} nodrag nopan`} onClick={(event) => event.stopPropagation()}>
        <Tool tip={question === undefined ? 'Ask about this' : asked ? 'Ask again' : 'Edit the question'} kbd="Q" icon="help" on={question !== undefined} onClick={onAsk} />
      </div>
      {badges.length > 0 && (
        <span className="rm-badges">
          {badges.map((badge) => (
            <span key={badge.n} className={`rm-badge ${badge.outcome}`}>{badge.n}</span>
          ))}
        </span>
      )}
      {part.broken.length > 0 && <span className="pf-tag rm-broken" title={`${part.broken.length} ${part.broken.length === 1 ? 'import points' : 'imports point'} at a removed file`}>BROKEN IMPORT</span>}
      <div className="pf-head">
        <KindIcon kind="module" />
        <span className="pf-title" title={part.title}>{part.title}</span>
        {tag !== null && <span className={`pf-tag rm-${part.outside ? 'outside' : part.status}`}>{tag}</span>}
      </div>
      <div className="pf-sub">{sub === '' ? ' ' : sub}</div>
      <div className="pf-file">
        {part.files.length > 0 ? (
          <>
            <b className="op-add">+{added}</b> <b className="op-del">−{removed}</b>
            <em> · {part.files.length} {part.files.length === 1 ? 'file' : 'files'}</em>
            <span className={`rm-progress${complete ? ' done' : ''}`}>{complete ? <Icon name="check" size={10} /> : null}{reviewed}/{part.files.length}</span>
          </>
        ) : (
          <span className="pf-quiet">{part.status === 'missing' ? 'planned, no change in the code' : 'unchanged'}</span>
        )}
      </div>
      {question !== undefined && !editing && (
        <div className="pf-chips">
          {asked ? (
            <button
              type="button"
              className="pf-chip rm-q sent nodrag nopan"
              title={`${question.text}\n\nThe answer is in the chat. Click to open it.`}
              onClick={(event) => {
                event.stopPropagation();
                onOpenChat();
              }}
            >
              <Icon name="check" size={11} />
              <span>Asked</span>
            </button>
          ) : (
            <span className="pf-chip rm-q" title={question.text}>
              <Icon name="help" size={11} />
              <span>{question.text}</span>
            </span>
          )}
        </div>
      )}
      {editing && <Pop label={`Ask about ${part.title}`} placeholder="What do you want to know? e.g. why is this here?" initial={draft} action="Save" onSave={onSave} onCancel={onCancel} />}
      <Handle type="source" position={POSITION[handles.source]} />
    </div>
  );
}
