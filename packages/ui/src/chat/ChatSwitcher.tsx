import { useEffect, useRef, useState } from 'react';
import type { ChatSummary, ClientMessage, ModelInfo } from '@ide/protocol';
import { Icon } from '../layout/Icon';
import { chatTitle, effortLabel, modelLabel, relativeTime } from './chats';

export interface ChatList {
  activeId: string | null;
  sessions: ChatSummary[];
  models: ModelInfo[];
}

export function ChatSwitcher({ chats, canLeave, send }: { chats: ChatList; canLeave: boolean; send: (message: ClientMessage) => boolean }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const active = chats.sessions.find((chat) => chat.id === chats.activeId);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  useEffect(() => {
    if (!open) {
      setConfirming(null);
      setRenaming(null);
    }
  }, [open]);
  const ask = (key: string, message: ClientMessage): void => {
    if (confirming !== key) {
      setConfirming(key);
      return;
    }
    setConfirming(null);
    send(message);
  };
  const commitRename = (): void => {
    if (renaming && renaming.text.trim() !== '') send({ type: 'session.rename', id: renaming.id, title: renaming.text });
    setRenaming(null);
  };
  const now = Date.now();
  const blocked = 'Wait for the agent to finish, or press Stop, before switching chats.';
  return (
    <div className="chat-switcher" ref={root}>
      <button className="chat-switcher-button" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open} title="Chats">
        <span className="chat-switcher-title">{active ? chatTitle(active) : 'New chat'}</span>
        <Icon name="chevron-down" size={16} />
      </button>
      <button className="chat-new" onClick={() => { if (canLeave) send({ type: 'session.new' }); }} disabled={!canLeave} title={canLeave ? 'New chat' : blocked} aria-label="New chat"><Icon name="plus" size={18} /></button>
      {open && (
        <ul className="chat-list" role="listbox" aria-label="Chats">
          {chats.sessions.length === 0 && <li className="muted chat-list-empty">No chats yet.</li>}
          {chats.sessions.map((chat) => (
            <li key={chat.id} role="option" aria-selected={chat.id === chats.activeId} className="chat-list-item">
              {renaming?.id === chat.id ? (
                <input
                  className="chat-rename"
                  autoFocus
                  value={renaming.text}
                  maxLength={200}
                  aria-label="Chat name"
                  onChange={(event) => setRenaming({ id: chat.id, text: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitRename();
                    if (event.key === 'Escape') setRenaming(null);
                  }}
                  onBlur={commitRename}
                />
              ) : (
              <button
                className={`chat-list-row${chat.id === chats.activeId ? ' on' : ''}`}
                disabled={chat.id !== chats.activeId && !canLeave}
                title={chat.id !== chats.activeId && !canLeave ? blocked : chatTitle(chat)}
                onClick={() => {
                  setOpen(false);
                  if (chat.id !== chats.activeId && send({ type: 'session.switch', id: chat.id })) return;
                }}
              >
                <span className="chat-list-title">{chatTitle(chat)}</span>
                <span className="chat-list-meta muted">
                  {relativeTime(chat.lastActivityAt, now)} · {modelLabel(chat.modelChoice, chats.models)} · {effortLabel(chat.effort)}
                </span>
              </button>
              )}
              <button className="chat-delete" onClick={() => setRenaming({ id: chat.id, text: chatTitle(chat) })} title="Rename this chat" aria-label="Rename chat"><Icon name="pencil" size={14} /></button>
              <button
                className={`chat-delete${confirming === chat.id ? ' confirm' : ''}`}
                onClick={() => ask(chat.id, { type: 'session.delete', id: chat.id })}
                title={confirming === chat.id ? 'Click again to delete this chat and stop its agent' : 'Delete this chat'}
                aria-label={confirming === chat.id ? 'Confirm delete chat' : 'Delete chat'}
              >
                {confirming === chat.id ? 'Delete?' : <Icon name="close" size={14} />}
              </button>
            </li>
          ))}
          {chats.sessions.length > 0 && (
            <li className="chat-list-footer">
              <button
                className={`chat-delete-all${confirming === 'all' ? ' confirm' : ''}`}
                onClick={() => ask('all', { type: 'session.delete-all' })}
                title="Delete every chat and stop the agent"
              >
                {confirming === 'all' ? 'Click again to delete all chats' : 'Delete all chats'}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
