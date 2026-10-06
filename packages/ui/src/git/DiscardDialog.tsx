import { useEffect, useRef } from 'react';

interface Props {
  paths: string[];
  deletes: number;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DiscardDialog({ paths, deletes, onCancel, onConfirm }: Props) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  const shown = paths.slice(0, 5);
  return (
    <div className="git-modal" role="presentation" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onCancel(); } }}>
      <div className="git-dialog" role="alertdialog" aria-modal="true" aria-labelledby="git-discard-title">
        <h3 id="git-discard-title">Discard changes in {paths.length === 1 ? 'this file' : `${paths.length} files`}?</h3>
        <ul>
          {shown.map((path) => <li key={path} className="mono">{path}</li>)}
          {paths.length > shown.length && <li className="muted">and {paths.length - shown.length} more</li>}
        </ul>
        <p className="muted">This cannot be undone.{deletes > 0 ? ` ${deletes === 1 ? 'An untracked file is' : `${deletes} untracked files are`} deleted.` : ''}</p>
        <div className="git-dialog-actions">
          <button type="button" ref={cancel} onClick={onCancel}>Cancel</button>
          <button type="button" className="danger" onClick={onConfirm}>Discard</button>
        </div>
      </div>
    </div>
  );
}
