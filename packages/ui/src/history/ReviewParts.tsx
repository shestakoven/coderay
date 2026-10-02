import type { MouseEvent, ReactNode } from 'react';
import { Icon } from '../layout/Icon';
import type { FileState } from './review-flow';
import { categoryOf } from './review-list';
import type { ReviewKind } from './review-model';

export function FileIcon({ path }: { path: string }) {
  return <span className={`rv-fileicon ${categoryOf(path)}`} aria-hidden="true"><Icon name="file-kind" size={14} /></span>;
}

export const Stat = ({ added, removed }: { added: number; removed: number }) => (
  <span className="review-stat">
    {added > 0 || removed === 0 ? <span className="add">+{added.toLocaleString()}</span> : null}{' '}
    {removed > 0 || added === 0 ? <span className="del">−{removed.toLocaleString()}</span> : null}
  </span>
);

export const Kbd = ({ children }: { children: ReactNode }) => <kbd>{children}</kbd>;

const BADGE: Record<ReviewKind, { short: string; long: string } | null> = {
  new: { short: 'NEW', long: 'NEW' },
  deleted: { short: 'DEL', long: 'DELETED' },
  renamed: { short: 'MOVED', long: 'RENAMED' },
  modified: null,
};

export function KindBadge({ kind, long = false }: { kind: ReviewKind | 'binary'; long?: boolean }) {
  if (kind === 'binary') return <span className="rv-badge binary">BINARY</span>;
  const badge = BADGE[kind];
  return badge ? <span className={`rv-badge ${kind}`}>{long ? badge.long : badge.short}</span> : null;
}

export const STATE_LABEL: Record<FileState, string> = {
  pending: 'Not reviewed',
  accepted: 'Accepted',
  requested: 'Changes requested',
  reverted: 'Reverted',
  changed: 'Changed since accepted',
  revised: 'Edited since requested',
};

const MARK_HINT: Record<FileState, string> = {
  pending: 'Accept',
  accepted: 'Accepted. Click to undo',
  requested: 'Changes requested. Click to take the request back',
  reverted: 'Reverted. Click to undo the revert',
  changed: 'Changed since you accepted it. Click to accept again',
  revised: 'Edited since you asked for changes. Click to accept',
};

export function StateMark({ state, onClick }: { state: FileState; onClick?: (event: MouseEvent) => void }) {
  const icon = state === 'accepted' ? <Icon name="check" size={11} /> : state === 'requested' ? <Icon name="comment" size={10} /> : state === 'reverted' ? <Icon name="undo" size={10} /> : null;
  return (
    <button
      className={`rv-mark ${state}`}
      tabIndex={-1}
      aria-label={MARK_HINT[state]}
      title={MARK_HINT[state]}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(event);
      }}
    >
      {icon}
    </button>
  );
}
