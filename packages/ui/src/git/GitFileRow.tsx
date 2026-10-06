import type { GitFile } from '@ide/protocol';
import { Icon } from '../layout/Icon';
import { kindLabel, kindLetter, splitPath } from './git-state';

export type GitGroup = 'conflicts' | 'staged' | 'changes' | 'untracked';

interface Props {
  file: GitFile;
  group: GitGroup;
  selected: boolean;
  tabbable: boolean;
  locked: boolean;
  blocked: string | null;
  onOpen: () => void;
  onFocus: () => void;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
}

export function GitFileRow({ file, group, selected, tabbable, locked, blocked, onOpen, onFocus, onStage, onUnstage, onDiscard }: Props) {
  const { name, dir } = splitPath(file.path);
  const kind = group === 'staged' ? file.index : file.worktree;
  const stop = (action: () => void) => (event: React.MouseEvent) => {
    event.stopPropagation();
    action();
  };
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={tabbable ? 0 : -1}
      data-row={`${group}:${file.path}`}
      className={`git-row${selected ? ' selected' : ''}`}
      title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
      onClick={onOpen}
      onFocus={onFocus}
    >
      <span className="git-name">{name}</span>
      {dir !== '' && <span className="git-dir"><bdi>{dir}</bdi></span>}
      <span className="git-actions">
        {group === 'staged' && (
          <button type="button" tabIndex={-1} aria-label={`Unstage ${file.path}`} data-tip="Unstage" disabled={locked} onClick={stop(onUnstage)}><Icon name="minus" size={14} /></button>
        )}
        {(group === 'changes' || group === 'untracked') && (
          <>
            <button type="button" tabIndex={-1} aria-label={`Discard changes in ${file.path}`} data-tip={blocked ?? 'Discard changes'} disabled={locked || blocked !== null} onClick={stop(onDiscard)}><Icon name="undo" size={14} /></button>
            <button type="button" tabIndex={-1} aria-label={`Stage ${file.path}`} data-tip="Stage" disabled={locked} onClick={stop(onStage)}><Icon name="plus" size={14} /></button>
          </>
        )}
      </span>
      {kind && <span className={`git-kind ${kind}`} title={kindLabel[kind]}>{kindLetter(kind)}</span>}
      {group === 'conflicts' && <span className="git-kind conflict" title="Conflicted">!</span>}
    </div>
  );
}
