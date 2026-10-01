import { useEffect, useState } from 'react';
import type { ClientMessage, SessionView } from '@ide/protocol';
import { configureMessage, effortOptions, isEffort, modelOptions } from './chats';

const RESTART_WAIT_MS = 1500;

export function ModelControls({ current, enabled, send }: { current: Pick<SessionView, 'modelChoice' | 'effort'>; enabled: boolean; send: (message: ClientMessage) => boolean }) {
  const [sentAt, setSentAt] = useState<number | null>(null);
  const settled = `${current.modelChoice ?? ''}|${current.effort ?? ''}`;
  useEffect(() => {
    if (sentAt === null) return;
    const timer = setTimeout(() => setSentAt(null), RESTART_WAIT_MS);
    return () => clearTimeout(timer);
  }, [sentAt, settled]);
  const apply = (change: Parameters<typeof configureMessage>[1]): void => {
    if (send(configureMessage(current, change))) setSentAt(Date.now());
  };
  const disabled = !enabled || sentAt !== null;
  const title = disabled ? 'Wait for the agent to finish, or press Stop, before changing the model.' : 'Applies to this chat. The agent restarts and resumes the conversation.';
  return (
    <span className="model-controls">
      <select
        aria-label="Model"
        title={title}
        disabled={disabled}
        value={current.modelChoice ?? ''}
        onChange={(event) => apply({ modelChoice: event.target.value === '' ? null : event.target.value })}
      >
        {modelOptions(current.modelChoice).map((option) => <option key={option.value ?? 'default'} value={option.value ?? ''}>{option.label}</option>)}
      </select>
      <select
        aria-label="Effort"
        title={title}
        disabled={disabled}
        value={current.effort ?? ''}
        onChange={(event) => apply({ effort: event.target.value !== '' && isEffort(event.target.value) ? event.target.value : null })}
      >
        {effortOptions.map((option) => <option key={option.value ?? 'default'} value={option.value ?? ''}>{option.label}</option>)}
      </select>
    </span>
  );
}
