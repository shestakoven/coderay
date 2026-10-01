import { useMemo, useState } from 'react';
import type { ClientMessage, FileAnswer, FileDiff, WatchdogAnswer, WatchdogEventView } from '@ide/protocol';
import {
  buildAnswer, canExpand, chooseDir, chooseFile, fileDiffRange, fileOptions, groupByDir, initialChoice, stopAgentLabel, visibleFiles,
  type DialogChoice, type DirGroup,
} from './dialog-state';

export interface DiffResult { error: string | null; diff?: FileDiff }

interface Props {
  event: WatchdogEventView;
  diffs: Record<string, DiffResult | undefined>;
  send: (message: ClientMessage) => boolean;
  requestDiff: (path: string, before: string | null, after: string | null) => string | null;
}

const ANSWER_LABEL: Record<FileAnswer, string> = { keep: 'Keep', revert: 'Revert', mine: 'My edit' };
const ANSWER_HINT: Record<FileAnswer, string> = {
  keep: 'Leave the file as the agent left it',
  revert: 'Restore the file to how it was before the change',
  mine: 'I made this change myself, not the agent: leave it alone',
};

export function WatchdogDialog({ event, diffs, send, requestDiff }: Props) {
  const [picked, setPicked] = useState<DialogChoice>({ files: {} });
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [requested, setRequested] = useState<Record<string, string>>({});
  const choice = useMemo<DialogChoice>(() => ({ files: { ...initialChoice(event).files, ...picked.files } }), [event, picked]);
  const groups = groupByDir(event, choice);
  const { shown, hidden } = visibleFiles(groups, expanded);
  const answer = buildAnswer(event, choice);
  const total = groups.reduce((n, g) => n + g.paths.length, 0);
  const chosen = groups.reduce((n, g) => n + g.paths.filter((path) => choice.files[path] !== undefined).length, 0);
  const stop = stopAgentLabel(event);
  const reply = (a: WatchdogAnswer): boolean => send({ type: 'watchdog.answer', eventId: event.id, answer: a });
  const showDiff = (path: string): void => {
    if (requested[path]) return;
    const range = fileDiffRange(event, path);
    if (!range) return;
    const id = requestDiff(path, range.before, range.after);
    if (id === null) setFailed({ ...failed, [path]: true });
    else setRequested({ ...requested, [path]: id });
  };
  return (
    <section className="watchdog" data-testid="watchdog-dialog">
      <h3>The agent changed files outside the approved plan</h3>
      <p>
        {event.interrupted ? 'The agent was stopped. Decide what happens to these changes.' : 'The agent is paused until you decide what happens to these changes.'}
        {!event.interrupted && event.runningSubagents > 0 ? ` ${event.runningSubagents} background subagent${event.runningSubagents === 1 ? ' keeps' : 's keep'} running.` : ''}
        {event.reason ? ` ${event.reason}` : ''}
      </p>
      {event.toolCalls.length > 0 && <div className="muted wd-label">Made by</div>}
      <ul className="wd-calls">
        {event.toolCalls.map((call) => <li key={call.toolUseId}><b>{call.tool}</b> <span className="muted">{call.summary}</span></li>)}
      </ul>
      {event.backgroundShell && <p className="note">A background shell was still running.</p>}
      {event.unknownOrigin && <p className="note">These files changed while the IDE was not running.</p>}
      <p className="muted wd-legend">
        {(['keep', 'revert', 'mine'] as const).map((a) => <span key={a}><b>{ANSWER_LABEL[a]}</b>: {ANSWER_HINT[a]}. </span>)}
      </p>
      {stop && <button onClick={() => send({ type: 'watchdog.stop-agent', eventId: event.id })}>{stop}</button>}
      {shown.map((group) => (
        <DirRow
          key={group.dir}
          group={group}
          choice={choice}
          onDir={(a) => setPicked(chooseDir(choice, group, a))}
          onFile={(path, a) => setPicked(chooseFile(choice, path, a))}
          onDiff={showDiff}
          diffs={diffs}
          requested={requested}
          failed={failed}
        />
      ))}
      {hidden > 0 && <button onClick={() => setExpanded(true)}>Show all ({hidden} more)</button>}
      <div className="wd-actions">
        <span className="muted wd-hint">{answer ? 'Or answer for all files at once:' : `${chosen} of ${total} files chosen. Choose for every file, or answer for all at once:`}</span>
        <button onClick={() => reply({ kind: 'all', answer: 'keep' })} title="Keep every file as the agent left it">Keep all</button>
        <button onClick={() => reply({ kind: 'all', answer: 'revert' })} title="Restore every file to how it was before">Revert all</button>
        {canExpand(event) && <button onClick={() => reply({ kind: 'all', answer: 'expand-plan' })} title="Add these files to the approved plan">Expand plan</button>}
        <button onClick={() => reply({ kind: 'all', answer: 'mine' })} title="I made all of these changes myself">All were my edits</button>
        <button className="primary" disabled={!answer} onClick={() => answer && reply(answer)}>Apply choices</button>
      </div>
    </section>
  );
}

function DirRow({ group, choice, onDir, onFile, onDiff, diffs, requested, failed }: {
  group: DirGroup;
  choice: DialogChoice;
  onDir: (a: FileAnswer) => void;
  onFile: (path: string, a: FileAnswer) => void;
  onDiff: (path: string) => void;
  diffs: Record<string, DiffResult | undefined>;
  requested: Record<string, string>;
  failed: Record<string, boolean>;
}) {
  return (
    <div className="wd-dir">
      <div className="wd-dir-head">
        <code>{group.dir}/</code> <span className="muted">{group.paths.length} {group.paths.length === 1 ? 'file' : 'files'}{group.answer === 'mixed' ? ' · mixed' : ''}</span>
        {group.paths.length > 1 && (
          <span className="wd-chips">
            <span className="muted">All in folder:</span>
            {(['keep', 'revert', 'mine'] as const).map((a) => (
              <button key={a} className={`chip ${group.answer === a ? 'on' : ''}`} aria-pressed={group.answer === a} title={`${ANSWER_HINT[a]} (every file in this folder)`} onClick={() => onDir(a)}>{ANSWER_LABEL[a]}</button>
            ))}
          </span>
        )}
      </div>
      {(group.shownPaths ?? group.paths).map((path) => {
        const result = requested[path] ? diffs[requested[path]] : undefined;
        return (
          <div key={path} className="wd-file">
            <div className="wd-file-row">
              <button className="link" aria-expanded={Boolean(requested[path])} aria-label={`Show the diff of ${path}`} title={path} onClick={() => onDiff(path)}>{path.slice(path.lastIndexOf('/') + 1)}</button>
              <span className="wd-chips">
                {fileOptions(path).map((a) => (
                  <button key={a} className={`chip ${choice.files[path] === a ? 'on' : ''}`} aria-pressed={choice.files[path] === a} title={ANSWER_HINT[a]} onClick={() => onFile(path, a)}>{ANSWER_LABEL[a]}</button>
                ))}
              </span>
            </div>
            {failed[path] && <div className="note">Not connected to the IDE core: the diff was not requested.</div>}
            {requested[path] && <DiffView result={result} />}
          </div>
        );
      })}
    </div>
  );
}

function DiffView({ result }: { result: DiffResult | undefined }) {
  if (!result) return <div className="muted">Loading the diff…</div>;
  if (result.error) return <div className="note">{result.error}</div>;
  const diff = result.diff;
  if (!diff) return null;
  if (diff.binary) return <div className="muted">Binary file.</div>;
  if (diff.missing) return <div className="muted">The content is not stored.</div>;
  return (
    <pre className="oop-diff">
      {diff.hunks.flatMap((hunk, h) => hunk.lines.map((line, i) => (
        <span key={`${h}-${i}`} className={line.op === 'add' ? 'add' : line.op === 'del' ? 'del' : undefined}>
          {(line.op === 'add' ? '+ ' : line.op === 'del' ? '- ' : '  ') + line.text + '\n'}
        </span>
      )))}
      {diff.truncated ? '…' : ''}
    </pre>
  );
}
