import { useEffect, useRef, useState } from 'react';
import type { GitBranch, GitStatus } from '@ide/protocol';
import { Icon } from '../layout/Icon';
import { useDismiss } from '../project/use-dismiss';
import type { GitClient } from './git-client';
import { matchBranches } from './git-state';

type Item = { kind: 'switch'; branch: GitBranch } | { kind: 'create'; name: string };

interface Props {
  status: GitStatus;
  client: GitClient;
  onClose: () => void;
}

export function BranchPopover({ status, client, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [branches, setBranches] = useState<GitBranch[] | null>(null);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useDismiss(ref, onClose);
  const load = (): void => {
    void client.request((requestId) => ({ type: 'git.branches', requestId })).then((result) => {
      if (result.error !== null) setError(result.error);
      else setBranches(result.branches ?? []);
    });
  };
  useEffect(load, [client]);

  const { matches, create } = matchBranches(branches ?? [], query);
  const items: Item[] = [
    ...[...matches].sort((a, b) => Number(b.current) - Number(a.current)).map((branch): Item => ({ kind: 'switch', branch })),
    ...(create !== null ? [{ kind: 'create', name: create } as Item] : []),
  ];
  const current = Math.min(index, Math.max(items.length - 1, 0));
  const blocked = status.busy !== null ? `Unavailable while ${status.busy}.` : status.operation !== null ? `A ${status.operation} is in progress.` : null;

  const pick = async (item: Item | undefined): Promise<void> => {
    if (!item) return;
    if (item.kind === 'switch' && item.branch.current) return onClose();
    if (blocked !== null) return;
    const result = await client.request(item.kind === 'create'
      ? (requestId) => ({ type: 'git.branch-create', requestId, name: item.name })
      : (requestId) => ({ type: 'git.branch-switch', requestId, name: item.branch.name }));
    if (result.error !== null) setError(result.error);
    else onClose();
  };
  const remove = async (name: string): Promise<void> => {
    const result = await client.request((requestId) => ({ type: 'git.branch-delete', requestId, name }));
    setError(result.error);
    if (result.error === null) load();
  };

  return (
    <div className="branch-pop" ref={ref} role="dialog" aria-label="Branches">
      <input
        autoFocus
        data-testid="branch-search"
        aria-label="Search or create a branch"
        placeholder="Search or create a branch…"
        value={query}
        onChange={(event) => { setQuery(event.target.value); setIndex(0); }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setIndex(Math.min(current + 1, items.length - 1)); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(Math.max(current - 1, 0)); }
          else if (event.key === 'Enter') { event.preventDefault(); void pick(items[current]); }
        }}
      />
      {blocked !== null && <p className="branch-note">{blocked}</p>}
      {error !== null && <p className="branch-note warn" role="alert">{error}</p>}
      <div role="listbox" aria-label="Branches" className="branch-list">
        {branches === null && error === null && <p className="branch-note">Loading…</p>}
        {items.map((item, at) => (
          <div key={item.kind === 'create' ? `create:${item.name}` : item.branch.name} role="option" aria-selected={at === current} className={`branch-item${at === current ? ' on' : ''}${blocked !== null && !(item.kind === 'switch' && item.branch.current) ? ' off' : ''}`} onMouseEnter={() => setIndex(at)} onClick={() => void pick(item)}>
            {item.kind === 'create' ? (
              <span>Create branch <b>{item.name}</b> from HEAD</span>
            ) : (
              <>
                <span className="branch-check">{item.branch.current && <Icon name="check" size={14} />}</span>
                <span className="branch-label">{item.branch.name}</span>
                {item.branch.upstream && <span className="branch-up">{item.branch.upstream}</span>}
                {!item.branch.current && (
                  <button type="button" tabIndex={-1} className="branch-del" aria-label={`Delete branch ${item.branch.name}`} data-tip="Delete branch (merged only)" onClick={(event) => { event.stopPropagation(); void remove(item.branch.name); }}><Icon name="trash" size={14} /></button>
                )}
              </>
            )}
          </div>
        ))}
        {branches !== null && items.length === 0 && <p className="branch-note">No branches match.</p>}
      </div>
    </div>
  );
}
