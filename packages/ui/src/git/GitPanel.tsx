import { useRef, useState } from 'react';
import type { GitFile, GitSide, GitStatus } from '@ide/protocol';
import { Icon } from '../layout/Icon';
import { CommitBox } from './CommitBox';
import { DiscardDialog } from './DiscardDialog';
import { GitFileRow, type GitGroup } from './GitFileRow';
import type { GitClient } from './git-client';
import { sections } from './git-state';
import './git.css';

export interface GitSelection {
  path: string;
  side: GitSide;
}

interface Props {
  status: GitStatus | null;
  client: GitClient;
  selection: GitSelection | null;
  onSelect: (selection: GitSelection) => void;
}

interface Group {
  key: GitGroup;
  title: string;
  files: GitFile[];
  side: GitSide;
}

export function GitPanel({ status, client, selection, onSelect }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [focused, setFocused] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const act = async (make: Parameters<GitClient['request']>[0]): Promise<void> => {
    const result = await client.request(make);
    setError(result.error);
  };
  const stage = (paths: string[]) => act((requestId) => ({ type: 'git.stage', requestId, paths }));
  const unstage = (paths: string[]) => act((requestId) => ({ type: 'git.unstage', requestId, paths }));

  if (status === null) return <div className="git-note muted" role="status">Reading the repository…</div>;
  if (status.problem !== null) {
    return (
      <div className="git-note">
        <p className="warn">{status.problem}</p>
        <button type="button" onClick={() => client.refresh()}>Retry</button>
      </div>
    );
  }
  if (!status.repo) {
    return (
      <div className="git-note">
        <p className="muted">This folder is not a git repository.</p>
        <button type="button" data-testid="git-init" onClick={() => void act((requestId) => ({ type: 'git.init', requestId }))}>Initialize repository</button>
        {error !== null && <p className="warn">{error}</p>}
      </div>
    );
  }

  const parts = sections(status);
  const groups: Group[] = [
    { key: 'conflicts', title: 'Conflicts', files: parts.conflicts, side: 'unstaged' },
    { key: 'staged', title: 'Staged', files: parts.staged, side: 'staged' },
    { key: 'changes', title: 'Changes', files: parts.changes, side: 'unstaged' },
    { key: 'untracked', title: 'Untracked', files: parts.untracked, side: 'unstaged' },
  ];
  const locked = status.operation !== null;
  const blocked = status.busy !== null ? `Unavailable while ${status.busy}` : null;
  const rowKeys = groups.flatMap((group) => group.files.map((file) => `${group.key}:${file.path}`));
  const tabKey = focused !== null && rowKeys.includes(focused) ? focused : (rowKeys[0] ?? null);
  const deletes = (paths: string[]) => paths.filter((path) => parts.untracked.some((file) => file.path === path)).length;

  const onKeyDown = (event: React.KeyboardEvent) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-row]');
    if (!row) return;
    const rows = [...(root.current?.querySelectorAll<HTMLElement>('[data-row]') ?? [])];
    const at = rows.indexOf(row);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      rows[at + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      row.click();
    } else if (event.key === ' ' && !locked) {
      event.preventDefault();
      const [group, ...rest] = (row.dataset.row ?? '').split(':');
      const path = rest.join(':');
      if (group === 'staged') void unstage([path]);
      else if (group === 'changes' || group === 'untracked') void stage([path]);
    }
  };

  return (
    <div className="git-pane" data-testid="git-panel" ref={root} onKeyDown={onKeyDown}>
      {status.operation !== null && <div className="git-banner warn">A {status.operation} is in progress. Continue in the terminal.</div>}
      {status.busy !== null && <div className="git-banner">Switching branches and discarding are unavailable while {status.busy}.</div>}
      {error !== null && (
        <div className="git-banner warn" role="alert">
          {error}
          <button type="button" aria-label="Dismiss" onClick={() => setError(null)}><Icon name="close" size={14} /></button>
        </div>
      )}
      <div className="git-lists">
        {status.files.length === 0 && <div className="git-note muted">No changes</div>}
        {groups.filter((group) => group.files.length > 0).map((group) => {
          const paths = group.files.map((file) => file.path);
          const closed = collapsed[group.key] === true;
          return (
            <section key={group.key} className="git-section">
              <div className="git-section-head">
                <button type="button" className="git-fold" aria-expanded={!closed} onClick={() => setCollapsed({ ...collapsed, [group.key]: !closed })}>
                  <Icon name={closed ? 'chevron-right' : 'chevron-down'} size={14} />
                  <span>{group.title}</span>
                  <span className="git-count">{group.files.length}</span>
                </button>
                <span className="git-actions">
                  {group.key === 'staged' && <button type="button" aria-label="Unstage all staged" data-tip="Unstage all" disabled={locked} onClick={() => void unstage(paths)}><Icon name="minus" size={14} /></button>}
                  {(group.key === 'changes' || group.key === 'untracked') && (
                    <>
                      <button type="button" aria-label={`Discard all ${group.title.toLowerCase()}`} data-tip={blocked ?? 'Discard all'} disabled={locked || blocked !== null} onClick={() => setConfirm(paths)}><Icon name="undo" size={14} /></button>
                      <button type="button" aria-label={`Stage all ${group.title.toLowerCase()}`} data-tip="Stage all" disabled={locked} onClick={() => void stage(paths)}><Icon name="plus" size={14} /></button>
                    </>
                  )}
                </span>
              </div>
              {!closed && (
                <div role="listbox" aria-label={`${group.title} files`}>
                  {group.files.map((file) => {
                    const key = `${group.key}:${file.path}`;
                    return (
                      <GitFileRow
                        key={key}
                        file={file}
                        group={group.key}
                        selected={selection?.path === file.path && selection.side === group.side}
                        tabbable={key === tabKey}
                        locked={locked}
                        blocked={blocked}
                        onOpen={() => onSelect({ path: file.path, side: group.side })}
                        onFocus={() => setFocused(key)}
                        onStage={() => void stage([file.path])}
                        onUnstage={() => void unstage([file.path])}
                        onDiscard={() => setConfirm([file.path])}
                      />
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>
      <CommitBox status={status} client={client} />
      {confirm !== null && (
        <DiscardDialog
          paths={confirm}
          deletes={deletes(confirm)}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const paths = confirm;
            setConfirm(null);
            void act((requestId) => ({ type: 'git.discard', requestId, paths }));
          }}
        />
      )}
    </div>
  );
}
