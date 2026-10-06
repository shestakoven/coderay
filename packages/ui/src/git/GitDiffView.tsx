import { useEffect, useRef, useState } from 'react';
import type { GitStatus } from '@ide/protocol';
import { DiffView } from '../history/DiffView';
import { Icon } from '../layout/Icon';
import type { GitClient, GitResult } from './git-client';
import type { GitSelection } from './GitPanel';

interface Props {
  selection: GitSelection;
  status: GitStatus;
  client: GitClient;
  onClose: () => void;
}

export function GitDiffView({ selection, status, client, onClose }: Props) {
  const file = status.files.find((item) => item.path === selection.path);
  const stamp = file ? `${file.index}:${file.worktree}` : 'gone';
  const [result, setResult] = useState<GitResult | null>(null);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => opener?.focus?.();
  }, []);
  useEffect(() => {
    root.current?.focus();
  }, [selection.path, selection.side]);
  useEffect(() => {
    if (stamp === 'gone') return;
    let live = true;
    void client.request((requestId) => ({ type: 'git.diff', requestId, path: selection.path, side: selection.side })).then((next) => {
      if (live) setResult(next);
    });
    return () => {
      live = false;
    };
  }, [client, selection.path, selection.side, stamp]);
  const diff = result?.diff;
  return (
    <section ref={root} tabIndex={-1} className="git-diff" data-testid="git-diff" aria-label={`Diff of ${selection.path}`} onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
      <header>
        <b className="mono">{selection.path}</b>
        <span className="muted">{selection.side === 'staged' ? 'Staged' : 'Changes'}</span>
        {diff && !diff.binary && <span className="git-counts"><i className="add">+{diff.added}</i> <i className="del">−{diff.removed}</i></span>}
        <span className="grow" />
        <button type="button" onClick={onClose} aria-label="Close diff" data-tip="Close" data-keys="Esc"><Icon name="close" size={16} /></button>
      </header>
      <div className="git-diff-body">
        {stamp === 'gone' ? <p className="muted">This file has no changes any more.</p>
          : result === null ? <p className="muted">Loading…</p>
          : result.error !== null ? <p className="warn">{result.error}</p>
          : diff?.binary ? <p className="muted">Binary file.</p>
          : diff && diff.hunks.length === 0 ? <p className="muted">No textual changes.</p>
          : diff ? (
            <>
              {diff.truncated && <p className="muted">The diff is long: only its start is shown.</p>}
              <DiffView diff={diff} path={selection.path} />
            </>
          ) : null}
      </div>
    </section>
  );
}
