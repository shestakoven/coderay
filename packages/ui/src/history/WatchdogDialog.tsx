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

export function WatchdogDialog({ event, diffs, send, requestDiff }: Props) {
  const [picked, setPicked] = useState<DialogChoice>({ files: {} });
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [requested, setRequested] = useState<Record<string, string>>({});
  const choice = useMemo<DialogChoice>(() => ({ files: { ...initialChoice(event).files, ...picked.files } }), [event, picked]);
  const groups = groupByDir(event, choice);
  const { shown, hidden } = visibleFiles(groups, expanded);
  const answer = buildAnswer(event, choice);
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
      <h3>Out of plan changes</h3>
      <p>
        {event.interrupted ? 'The agent was interrupted.' : 'The agent is paused.'}
        {!event.interrupted && event.runningSubagents > 0 ? ` ${event.runningSubagents} background subagent${event.runningSubagents === 1 ? ' keeps' : 's keep'} running.` : ''}
        {event.reason ? ` ${event.reason}` : ''}
      </p>
      <ul className="wd-calls">
        {event.toolCalls.map((call) => <li key={call.toolUseId}><b>{call.tool}</b> <span className="muted">{call.summary}</span></li>)}
      </ul>
      {event.backgroundShell && <p className="note">A background shell was still running.</p>}
      {event.unknownOrigin && <p className="note">These files changed while the IDE was not running.</p>}
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
        <button onClick={() => reply({ kind: 'all', answer: 'keep' })}>Keep all</button>
        <button onClick={() => reply({ kind: 'all', answer: 'revert' })}>Revert all</button>
        {canExpand(event) && <button onClick={() => reply({ kind: 'all', answer: 'expand-plan' })}>Expand plan</button>}
        <button onClick={() => reply({ kind: 'all', answer: 'mine' })}>This was my edit</button>
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
        <span className="wd-chips">
          {(['keep', 'revert', 'mine'] as const).map((a) => (
            <button key={a} className={`chip ${group.answer === a ? 'on' : ''}`} aria-pressed={group.answer === a} onClick={() => onDir(a)}>{ANSWER_LABEL[a]}</button>
          ))}
        </span>
      </div>
      {(group.shownPaths ?? group.paths).map((path) => {
        const result = requested[path] ? diffs[requested[path]] : undefined;
        return (
          <div key={path} className="wd-file">
            <div className="wd-file-row">
              <button className="link" aria-expanded={Boolean(requested[path])} aria-label={`Show the diff of ${path}`} title={path} onClick={() => onDiff(path)}>{path.slice(path.lastIndexOf('/') + 1)}</button>
              <span className="wd-chips">
                {fileOptions(path).map((a) => (
                  <button key={a} className={`chip ${choice.files[path] === a ? 'on' : ''}`} aria-pressed={choice.files[path] === a} onClick={() => onFile(path, a)}>{ANSWER_LABEL[a]}</button>
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
