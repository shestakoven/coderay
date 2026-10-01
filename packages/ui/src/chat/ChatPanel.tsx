import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ChatItem, ClientMessage, GateAnswer, GatePromptView, ToolStatus } from '@ide/protocol';
import { canSend, canStop, childItems, decisionLabel, filterItems, runningTasks, stopControl, turnGroups, type ChatState } from './chat-state';
import { PromptBody } from '../plan/PromptBody';
import { promptTarget } from '../plan/prompt-text';
import { PromptCard } from './PromptCard';
import { ChatSwitcher, type ChatList } from './ChatSwitcher';
import { Icon } from '../layout/Icon';
import { MarkdownText } from './MarkdownText';
import { UsageMeter } from './UsageMeter';
import { ModelControls } from './ModelControls';
import { addAttachments, imageFiles, type Attachment } from './attachments';
import { WorkingIndicator } from './WorkingIndicator';
import { workingState } from './working';

const RECOVERED = "recovered from claude's transcript";

const STATUS_MARK: Record<ToolStatus, string> = { running: '…', ok: '✓', error: '✗', rejected: '⊘', unfinished: '–' };
const TURN_END: Record<string, string> = { error_during_execution: 'stopped', crashed: 'ended: claude exited' };
const START_WAIT_MS = 15000;
const BUSY = 'The agent is busy. Wait for the turn to end, press Stop to end it, or Restart to also end background tasks.';

export function ChatPanel({ chat, chats, send, onClearFilter, onDismissError, planRow, prompts, promptAnchored, onAnswerPrompt, onFocusTargets, dialog }: {
  chat: ChatState;
  chats: ChatList;
  send: (message: ClientMessage) => boolean;
  onClearFilter: () => void;
  onDismissError: () => void;
  planRow: { text: string; onOpen: () => void } | null;
  prompts: GatePromptView[];
  promptAnchored: boolean;
  onAnswerPrompt: (id: string, answer: GateAnswer) => void;
  onFocusTargets: (paths: string[]) => void;
  dialog: ReactNode;
}) {
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachProblem, setAttachProblem] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const groups = turnGroups(chat);
  const itemCount = Object.keys(chat.items).length;
  const sendable = canSend(chat);
  const tasks = runningTasks(chat);
  const stop = stopControl(chat);

  const working = workingState(chat, sentAt);
  const active = working !== null;
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [itemCount, active]);
  useEffect(() => {
    if (sentAt === null) return;
    const timer = setTimeout(() => setSentAt(null), START_WAIT_MS);
    return () => clearTimeout(timer);
  }, [sentAt]);
  useEffect(() => {
    if (sentAt !== null && (chat.error !== null || Object.values(chat.turns).some((turn) => turn.closedAt === null))) setSentAt(null);
  }, [sentAt, chat.error, chat.turns]);

  const attach = async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    const result = await addAttachments(attachments, files);
    setAttachments(result.attachments);
    setAttachProblem(result.problem);
  };
  const canSubmit = draft.trim() !== '' || attachments.length > 0;
  const submit = (): void => {
    if (!sendable || !canSubmit) return;
    const images = attachments.map(({ mediaType, data }) => ({ mediaType, data }));
    if (send(images.length > 0 ? { type: 'chat.send', text: draft, images } : { type: 'chat.send', text: draft })) {
      setDraft('');
      setAttachments([]);
      setAttachProblem(null);
      setSentAt(Date.now());
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submit();
  };

  return (
    <section className="chat">
      <header className={`chat-header${active ? ' working-on' : ''}`}>
        <ChatSwitcher chats={chats} canLeave={sendable} send={send} />
        <span className="chat-status muted" title={chat.session?.model ?? undefined}>{chat.session ? (chat.session.status === 'refused' ? 'hook off' : chat.session.status) : 'no session yet'}</span>
        {chat.session?.permissionMode === 'plan' && (
          <span className="badge plan" title="The agent explores and plans, and changes no files until you approve a plan.">plan mode</span>
        )}
        {tasks.length > 0 && (
          <span className="muted" title={tasks.map((task) => task.description).join('\n')}>⟳ {tasks.length} background</span>
        )}
        <span className="spacer" />
        <button onClick={() => send({ type: 'session.restart' })} disabled={chat.session?.status !== 'running'}>Restart</button>
      </header>
      {dialog}
      {planRow && (
        <button className="plan-row" onClick={planRow.onOpen}>≡ {planRow.text}</button>
      )}
      {chat.filter && (
        <div className="chat-filter" data-testid="chat-filter">
          <span>Filtered to {chat.filter.label}</span>
          <button onClick={onClearFilter}>Clear filter</button>
        </div>
      )}
      <div className="chat-log">
        {groups.map((group) => ({ group, items: filterItems(group.items, chat.filter) })).filter(({ items }) => items.length > 0).map(({ group, items }) => (
          <div key={group.items[0]?.id} className={`turn ${group.turn?.kind ?? 'outside'}`}>
            {group.turn?.kind === 'agent-initiated' && <div className="turn-marker">↻ agent-initiated turn</div>}
            {!group.turn && group.items.some((item) => item.kind !== 'notice') && <div className="turn-marker">outside a turn</div>}
            {items.map((item) => <Item key={item.id} item={item} chat={chat} send={send} onFocusTargets={onFocusTargets} />)}
            {group.turn?.resultSubtype && TURN_END[group.turn.resultSubtype] && (
              <div className="turn-end">{TURN_END[group.turn.resultSubtype]}</div>
            )}
          </div>
        ))}
        {working && <WorkingIndicator key={working.since} working={working} />}
        <div ref={end} />
      </div>
      {prompts.map((prompt, index) => (
        <details key={prompt.id} className="prompt gate" open={!(index === 0 && promptAnchored)} data-testid="gate-card">
          <summary>
            ⚠ Out of plan: {prompt.tool} <code>{promptTarget(prompt)?.path ?? prompt.summary}</code>
            {index === 0 && promptAnchored ? ' · on the map' : ''}
          </summary>
          <PromptBody prompt={prompt} onAnswer={(answer) => onAnswerPrompt(prompt.id, answer)} />
        </details>
      ))}
      {chat.error && (
        <button className="chat-error" onClick={onDismissError}>{chat.error} ✕</button>
      )}
      <footer
        className="composer"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void attach(imageFiles(event.dataTransfer.files));
        }}
      >
        {attachments.length > 0 && (
          <div className="attachments">
            {attachments.map((item) => (
              <div key={item.id} className="attachment" title={item.name}>
                <img src={`data:${item.mediaType};base64,${item.data}`} alt={item.name} />
                <button onClick={() => setAttachments(attachments.filter((other) => other.id !== item.id))} aria-label={`Remove ${item.name}`}>✕</button>
              </div>
            ))}
          </div>
        )}
        {attachProblem && <div className="attach-problem">{attachProblem}</div>}
        <textarea
          rows={3}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            const files = imageFiles(event.clipboardData.files);
            if (files.length === 0) return;
            event.preventDefault();
            void attach(files);
          }}
          placeholder={sendable ? 'Message the agent (Enter sends, Shift+Enter adds a line)' : BUSY}
        />
        <div className="composer-actions">
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(event) => {
            void attach(imageFiles(event.target.files ?? []));
            event.target.value = '';
          }} />
          <button className="composer-action" onClick={() => fileInput.current?.click()} title="Attach images" aria-label="Attach images">
            <Icon name="paperclip" size={18} />
          </button>
          <ModelControls current={chat.session ?? chats.sessions[0] ?? { modelChoice: null, effort: null }} models={chats.models} enabled={sendable} send={send} />
          <UsageMeter usage={chat.usage} />
          <span className="spacer" />
          {sendable ? (
            <button className="composer-action send" onClick={submit} disabled={!canSubmit} title="Send (Enter)" aria-label="Send">
              <Icon name="send" size={18} />
            </button>
          ) : (
            <button className="composer-action stop" onClick={() => send({ type: 'chat.stop' })} disabled={!canStop(chat)} title={stop.title} aria-label={stop.label}>
              <Icon name="stop" size={18} />
              {stop.label !== 'Stop' && <span>{stop.label.slice('Stop'.length).trim()}</span>}
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}

function Item({ item, chat, send, onFocusTargets }: {
  item: ChatItem;
  chat: ChatState;
  send: (message: ClientMessage) => boolean;
  onFocusTargets: (paths: string[]) => void;
}) {
  if (item.kind === 'message') {
    return (
      <div className={`msg ${item.role}${item.role === 'assistant' ? ' rich' : ''}`} title={item.recovered ? RECOVERED : undefined}>
        {item.role === 'assistant' ? <MarkdownText text={item.text} /> : item.text}
        {item.recovered && <span className="muted"> · {RECOVERED}</span>}
      </div>
    );
  }
  if (item.kind === 'notice') return <div className="notice">{item.text}</div>;
  if (item.kind === 'prompt') {
    return <PromptCard item={item} onAnswer={(answer) => send({ type: 'prompt.answer', requestId: item.id, answer })} />;
  }
  const children = childItems(chat, item.id);
  const label = decisionLabel(item.decision);
  const row = (
    <>
      <span className="tool-status">{STATUS_MARK[item.status]}</span> <b>{item.tool}</b>
      {label && <span className={`decision ${item.decision}`}> · {label}</span>}{item.recovered && <span className="muted"> · {RECOVERED}</span>} <span className="muted">{item.summary}</span>
    </>
  );
  return (
    <div className={`tool ${item.status}`}>
      {item.targets.length > 0
        ? <button className="tool-row link-row" title={item.summary} onClick={() => onFocusTargets(item.targets)}>{row}</button>
        : <div className="tool-row" title={item.summary}>{row}</div>}
      {children.length > 0 && (
        <div className="tool-children">
          {children.map((child) => <Item key={child.id} item={child} chat={chat} send={send} onFocusTargets={onFocusTargets} />)}
        </div>
      )}
    </div>
  );
}
