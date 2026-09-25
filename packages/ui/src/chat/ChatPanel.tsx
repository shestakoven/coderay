import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ChatItem, ClientMessage, ToolStatus } from '@ide/protocol';
import { canSend, canStop, childItems, runningTasks, stopControl, turnGroups, type ChatState } from './chat-state';
import { PromptCard } from './PromptCard';

const STATUS_MARK: Record<ToolStatus, string> = { running: '…', ok: '✓', error: '✗', rejected: '⊘', unfinished: '–' };
const TURN_END: Record<string, string> = { error_during_execution: 'stopped', crashed: 'ended: claude exited' };
const BUSY = 'The agent is busy. Wait for the turn to end, press Stop to end it, or Restart to also end background tasks.';

export function ChatPanel({ chat, send, onDismissError }: {
  chat: ChatState;
  send: (message: ClientMessage) => boolean;
  onDismissError: () => void;
}) {
  const [draft, setDraft] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const groups = turnGroups(chat);
  const itemCount = Object.keys(chat.items).length;
  const sendable = canSend(chat);
  const tasks = runningTasks(chat);
  const stop = stopControl(chat);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [itemCount]);

  const submit = (): void => {
    if (!sendable || draft.trim() === '') return;
    if (send({ type: 'chat.send', text: draft })) setDraft('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submit();
  };

  return (
    <section className="chat">
      <header className="chat-header">
        <span>{chat.session ? `${chat.session.status}${chat.session.model ? ` · ${chat.session.model}` : ''}` : 'no session yet'}</span>
        {chat.session?.permissionMode === 'plan' && (
          <span className="badge plan" title="The agent explores and plans, and changes no files until you approve a plan.">plan mode</span>
        )}
        {tasks.length > 0 && (
          <span className="muted" title={tasks.map((task) => task.description).join('\n')}>⟳ {tasks.length} background</span>
        )}
        <span className="spacer" />
        <button onClick={() => send({ type: 'session.restart' })} disabled={chat.session?.status !== 'running'}>Restart</button>
        <button onClick={() => send({ type: 'session.new' })} disabled={!chat.session}>New session</button>
      </header>
      <div className="chat-log">
        {groups.map((group) => (
          <div key={group.items[0]?.id} className={`turn ${group.turn?.kind ?? 'outside'}`}>
            {group.turn?.kind === 'agent-initiated' && <div className="turn-marker">↻ agent-initiated turn</div>}
            {!group.turn && group.items.some((item) => item.kind !== 'notice') && <div className="turn-marker">outside a turn</div>}
            {group.items.map((item) => <Item key={item.id} item={item} chat={chat} send={send} />)}
            {group.turn?.resultSubtype && TURN_END[group.turn.resultSubtype] && (
              <div className="turn-end">{TURN_END[group.turn.resultSubtype]}</div>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      {chat.error && (
        <button className="chat-error" onClick={onDismissError}>{chat.error} ✕</button>
      )}
      <footer className="composer">
        <textarea
          rows={3}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={sendable ? 'Message the agent (Enter sends, Shift+Enter adds a line)' : BUSY}
        />
        <div className="composer-actions">
          <button onClick={() => send({ type: 'chat.stop' })} disabled={!canStop(chat)} title={stop.title}>{stop.label}</button>
          <button onClick={submit} disabled={!sendable || draft.trim() === ''}>Send</button>
        </div>
      </footer>
    </section>
  );
}

function Item({ item, chat, send }: { item: ChatItem; chat: ChatState; send: (message: ClientMessage) => boolean }) {
  if (item.kind === 'message') return <div className={`msg ${item.role}`}>{item.text}</div>;
  if (item.kind === 'notice') return <div className="notice">{item.text}</div>;
  if (item.kind === 'prompt') {
    return <PromptCard item={item} onAnswer={(answer) => send({ type: 'prompt.answer', requestId: item.id, answer })} />;
  }
  const children = childItems(chat, item.id);
  return (
    <div className={`tool ${item.status}`}>
      <div className="tool-row" title={item.summary}>
        <span className="tool-status">{STATUS_MARK[item.status]}</span> <b>{item.tool}</b> <span className="muted">{item.summary}</span>
      </div>
      {children.length > 0 && (
        <div className="tool-children">
          {children.map((child) => <Item key={child.id} item={child} chat={chat} send={send} />)}
        </div>
      )}
    </div>
  );
}
