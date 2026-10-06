import { useRef, useState } from 'react';
import type { GitStatus } from '@ide/protocol';
import { isMac } from '../project/shortcuts';
import type { GitClient } from './git-client';
import { commitState } from './git-state';

const SUBJECT_LIMIT = 72;

export function CommitBox({ status, client }: { status: GitStatus; client: GitClient }) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const state = commitState(status, message);
  const subject = message.split('\n', 1)[0] ?? '';
  const long = subject.length > SUBJECT_LIMIT;
  const commit = async (): Promise<void> => {
    if (!state.enabled || committing) return;
    setCommitting(true);
    const result = await client.request((requestId) => ({ type: 'git.commit', requestId, message }));
    setCommitting(false);
    setError(result.error);
    if (result.error === null) {
      setMessage('');
      area.current?.focus();
    }
  };
  return (
    <form className="git-commit" onSubmit={(event) => { event.preventDefault(); void commit(); }}>
      <textarea
        ref={area}
        data-testid="git-commit-message"
        aria-label="Commit message"
        placeholder={`Message (${isMac() ? '⌘' : 'Ctrl+'}Enter to commit)`}
        rows={3}
        value={message}
        onChange={(event) => {
          setMessage(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void commit();
          }
        }}
      />
      <div className="git-commit-row">
        <span className={`git-hint${long ? ' warn' : ''}`}>{long ? `The subject is ${subject.length} characters long` : (state.reason ?? '')}</span>
        <button type="submit" data-testid="git-commit" disabled={!state.enabled || committing}>{committing ? 'Committing…' : 'Commit'}</button>
      </div>
      {error !== null && <pre className="git-error" role="alert">{error}</pre>}
    </form>
  );
}
