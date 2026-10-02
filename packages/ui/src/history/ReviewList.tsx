import { memo, useEffect, useRef, type RefObject } from 'react';
import { Icon } from '../layout/Icon';
import { fileState, isOpen, type Decisions, type FileState, type Position, type Tally } from './review-flow';
import type { ListFilter } from './review-list';
import { kindOf, type ReviewItem, type ReviewSection } from './review-model';
import { FilePath } from './ReviewPanel';
import { FileIcon, Kbd, KindBadge, StateMark, Stat, STATE_LABEL } from './ReviewParts';

interface Props {
  sections: ReviewSection[];
  totals: Record<string, { decided: number; total: number }>;
  decisions: Decisions;
  selected: Position | null;
  tally: Tally;
  filter: ListFilter;
  onFilter: (filter: ListFilter) => void;
  filterRef: RefObject<HTMLInputElement | null>;
  collapsed: Record<string, boolean>;
  onToggle: (key: string) => void;
  onSelect: (position: Position) => void;
  onMark: (file: ReviewItem, state: FileState) => void;
  onAcceptGroup: (section: ReviewSection) => void;
  commentCounts: Record<string, number>;
  unsentComments: number;
  unsentFiles: number;
  onRequestChanges: () => void;
  onExit: () => void;
}

const same = (a: Position | null, group: string, path: string): boolean => a !== null && a.group === group && a.path === path;

export function ReviewList({ sections, totals, decisions, selected, tally, filter, onFilter, filterRef, collapsed, onToggle, onSelect, onMark, onAcceptGroup, commentCounts, unsentComments, unsentFiles, onRequestChanges, onExit }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected?.group, selected?.path]);
  const handled = tally.accepted + tally.requested + tally.reverted;
  const percent = (value: number): string => (tally.total === 0 ? '0%' : `${(value / tally.total) * 100}%`);
  const filtering = filter.query.trim() !== '' || filter.onlyPending;

  return (
    <aside className="rv-list" aria-label="Files to review">
      <header className="rv-list-head">
        <h2>Review</h2>
        <span className="rv-count">{handled} of {tally.total}</span>
        <button className="rv-icon" onClick={onExit} title="Exit review (Esc)" aria-label="Exit review"><Icon name="close" size={16} /></button>
      </header>
      <div className="rv-bar" role="progressbar" aria-label="Review progress" aria-valuemin={0} aria-valuemax={tally.total} aria-valuenow={handled}>
        <i className="accepted" style={{ width: percent(tally.accepted) }} />
        <i className="requested" style={{ width: percent(tally.requested) }} />
        <i className="reverted" style={{ width: percent(tally.reverted) }} />
      </div>
      <div className="rv-filter">
        <label className="rv-search">
          <Icon name="search" size={14} />
          <input
            ref={filterRef}
            value={filter.query}
            placeholder="Filter files"
            aria-label="Filter files"
            spellCheck={false}
            onChange={(event) => onFilter({ ...filter, query: event.target.value })}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.stopPropagation();
              if (filter.query !== '') onFilter({ ...filter, query: '' });
              else event.currentTarget.blur();
            }}
          />
          {filter.query === '' ? <Kbd>/</Kbd> : <button className="rv-clear" onClick={() => onFilter({ ...filter, query: '' })} aria-label="Clear the filter"><Icon name="close" size={12} /></button>}
        </label>
        <button className={`rv-toggle${filter.onlyPending ? ' on' : ''}`} aria-pressed={filter.onlyPending} onClick={() => onFilter({ ...filter, onlyPending: !filter.onlyPending })} title="Hide files you have already decided on">Only pending</button>
      </div>
      <div className="rv-scroll" ref={scroller}>
        {sections.map((section) => {
          const open = section.files.filter((file) => isOpen(fileState(decisions.reviewed, decisions.requested, file)));
          const decided = section.files.length - open.length;
          const folded = collapsed[section.key] === true;
          return (
            <section key={section.key} className={`rv-group${section.outOfPlan ? ' out' : ''}`} aria-label={section.title}>
              <header className="rv-group-head">
                <button className="rv-group-toggle" aria-expanded={!folded} onClick={() => onToggle(section.key)} title={section.title}>
                  <Icon name={folded ? 'chevron-right' : 'chevron-down'} size={14} />
                  {section.outOfPlan && <Icon name="alert" size={13} />}
                  <span className="rv-group-name">{section.title}</span>
                </button>
                <span className="rv-group-count">{totals[section.key]?.decided ?? decided}/{totals[section.key]?.total ?? section.files.length}</span>
                {open.length > 0 && !filtering && (
                  <button className="rv-accept-all" onClick={() => onAcceptGroup(section)} title={`Accept the ${open.length} undecided ${open.length === 1 ? 'file' : 'files'} in this group`} aria-label={`Accept all ${open.length} undecided files in ${section.title}`}>
                    Accept all <b>{open.length}</b>
                  </button>
                )}
              </header>
              {!folded && (
                <ul className="rv-files">
                  {section.files.map((file) => (
                    <Row
                      key={file.path}
                      groupKey={section.key}
                      file={file}
                      state={fileState(decisions.reviewed, decisions.requested, file)}
                      on={same(selected, section.key, file.path)}
                      comments={commentCounts[file.path] ?? 0}
                      onSelect={onSelect}
                      onMark={onMark}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
        {sections.length === 0 && (
          <div className="rv-list-empty">
            {filtering
              ? <><p>No files match.</p><button onClick={() => onFilter({ query: '', onlyPending: false })}>Clear the filter</button></>
              : <p>Nothing to review yet. Changes the agent makes show up here.</p>}
          </div>
        )}
      </div>
      {unsentComments > 0 && (
        <footer className="rv-list-foot">
          <button className="rv-request" onClick={onRequestChanges}>
            <Icon name="send" size={14} /> Request changes <b>{unsentComments}</b>
          </button>
          <span className="rv-foot-note">{unsentComments} {unsentComments === 1 ? 'comment' : 'comments'} on {unsentFiles} {unsentFiles === 1 ? 'file' : 'files'} go to the agent in one message</span>
        </footer>
      )}
    </aside>
  );
}

const Row = memo(function Row({ groupKey, file, state, on, comments, onSelect, onMark }: {
  groupKey: string;
  file: ReviewItem;
  state: FileState;
  on: boolean;
  comments: number;
  onSelect: (position: Position) => void;
  onMark: (file: ReviewItem, state: FileState) => void;
}) {
  return (
    <li className={`rv-row ${state}${on ? ' on' : ''}`}>
      <StateMark state={state} onClick={() => onMark(file, state)} />
      <button className="rv-row-main" aria-current={on ? 'true' : undefined} onClick={() => onSelect({ group: groupKey, path: file.path })} title={`${file.path}\n${STATE_LABEL[state]}`}>
        <FileIcon path={file.path} />
        <FilePath path={file.path} />
        <KindBadge kind={kindOf(file)} />
        {comments > 0 && <span className="rv-comments" title={`${comments} ${comments === 1 ? 'comment' : 'comments'} not sent yet`}><Icon name="comment" size={11} />{comments}</span>}
        <Stat added={file.added} removed={file.removed} />
      </button>
    </li>
  );
});
