import { useState } from 'react';
import type { GitStatus } from '@ide/protocol';
import { Icon } from '../layout/Icon';
import { BranchPopover } from './BranchPopover';
import type { GitClient } from './git-client';
import { chipView } from './git-state';

export function BranchChip({ status, client }: { status: GitStatus | null; client: GitClient }) {
  const [open, setOpen] = useState(false);
  const view = status ? chipView(status) : null;
  if (!status || !view) return null;
  return (
    <div className="branch-wrap">
      <button type="button" className={`branch-chip${open ? ' on' : ''}`} data-testid="branch-chip" data-menu-anchor aria-haspopup="listbox" aria-expanded={open} data-tip={view.title} onClick={() => setOpen(!open)}>
        <Icon name="git-branch" size={14} />
        <span className="branch-name">{view.label}</span>
        {view.dirty && <i className="branch-dirty" role="img" aria-label="Uncommitted changes" />}
        {view.ahead > 0 && <span className="branch-sync">↑{view.ahead}</span>}
        {view.behind > 0 && <span className="branch-sync">↓{view.behind}</span>}
      </button>
      {open && <BranchPopover status={status} client={client} onClose={() => setOpen(false)} />}
    </div>
  );
}
