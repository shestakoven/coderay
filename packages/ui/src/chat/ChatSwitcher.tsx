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
            <li key={chat.id} role="option" aria-selected={chat.id === chats.activeId}>
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
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
