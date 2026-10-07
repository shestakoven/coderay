import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ChatItem, ClientMessage, GateAnswer, GatePromptView, ToolStatus } from '@ide/protocol';
import { canSend, canStop, childItems, decisionLabel, filterItems, runningTasks, stopControl, turnGroups, type ChatState } from './chat-state';
import { PromptBody } from '../plan/PromptBody';
import { promptTarget, targetLabel } from '../plan/prompt-text';
import { PromptCard } from './PromptCard';
import { ChatSwitcher, type ChatList } from './ChatSwitcher';
import { Icon } from '../layout/Icon';
import { MarkdownText } from './MarkdownText';
import { UsageMeter } from './UsageMeter';
import { BackgroundTasks } from './BackgroundTasks';
import { ModelControls } from './ModelControls';
import { addAttachments, imageFiles, type Attachment } from './attachments';
import { WorkingIndicator } from './WorkingIndicator';
import { workingState } from './working';
import { matchSkills, skillCommand, slashQuery } from './skills';
import { SkillMenu, SkillMenuEmpty } from './SkillMenu';

const RECOVERED = "recovered from claude's transcript";

const STATUS_MARK: Record<ToolStatus, string> = { running: '…', ok: '✓', error: '✗', rejected: '⊘', unfinished: '–' };
const TURN_END: Record<string, string> = { error_during_execution: 'stopped', crashed: 'ended: claude exited' };
const START_WAIT_MS = 15000;
const BUSY = 'The agent is working: it reads your message at its next step. Enter sends.';

export type AgentView = 'chat' | 'terminal';

export function ChatPanel({ chat, chats, send, focusItem, onClearFilter, onDismissError, prompts, promptAnchored, onAnswerPrompt, onFocusTargets, dialog, planDock, view, onView, terminal }: {
  chat: ChatState;
  chats: ChatList;
  send: (message: ClientMessage) => boolean;
  focusItem?: { id: string; nonce: number } | null;
  onClearFilter: () => void;
  onDismissError: () => void;
  prompts: GatePromptView[];
  promptAnchored: boolean;
  onAnswerPrompt: (id: string, answer: GateAnswer) => void;
  onFocusTargets: (paths: string[]) => void;
  dialog: ReactNode;
  planDock?: ReactNode;
  view: AgentView;
  onView: (view: AgentView) => void;
  terminal: ReactNode;
}) {
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachProblem, setAttachProblem] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [skillIndex, setSkillIndex] = useState(0);
  const [skillsDismissed, setSkillsDismissed] = useState(false);
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
  }, [itemCount, active, chat.draft.length]);
  useEffect(() => {
    if (!focusItem) return;
    const target = [...document.querySelectorAll<HTMLElement>('[data-item-id]')].find((element) => element.dataset.itemId === focusItem.id);
    if (!target) return;
    target.scrollIntoView({ block: 'center' });
    target.classList.add('flash');
    const timer = setTimeout(() => target.classList.remove('flash'), 1800);
    return () => clearTimeout(timer);
  }, [focusItem]);
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
  const query = slashQuery(draft);
  const skillMatches = query === null ? [] : matchSkills(chat.skills, query);
  const skillMenu = query !== null && !skillsDismissed && (chat.skills.length === 0 || skillMatches.length > 0);
  const skillActive = Math.min(skillIndex, Math.max(skillMatches.length - 1, 0));
  const changeDraft = (text: string): void => {
    setDraft(text);
    setSkillIndex(0);
    setSkillsDismissed(false);
  };
  const pickSkill = (skill: string): void => {
    changeDraft(skillCommand(skill));
    composer.current?.focus();
  };
  const submit = (): void => {
    if (!canSubmit) return;
    const images = attachments.map(({ mediaType, data }) => ({ mediaType, data }));
    if (send(images.length > 0 ? { type: 'chat.send', text: draft, images } : { type: 'chat.send', text: draft })) {
      setDraft('');
      setAttachments([]);
      setAttachProblem(null);
      if (sendable) setSentAt(Date.now());
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const composing = event.nativeEvent.isComposing || event.keyCode === 229;
    if (skillMenu && !composing) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSkillsDismissed(true);
        return;
      }
      const chosen = skillMatches[skillActive];
      if (chosen !== undefined) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          setSkillIndex((skillActive + (event.key === 'ArrowDown' ? 1 : skillMatches.length - 1)) % skillMatches.length);
          return;
        }
        // A fully typed skill name sends; Enter completes only a partial one.
        if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && chosen !== query)) {
          event.preventDefault();
          pickSkill(chosen);
          return;
        }
      }
    }
    if (event.key !== 'Enter' || event.shiftKey || composing) return;
    event.preventDefault();
    submit();
  };

  return (
    <section className="chat">
      <header className={`chat-header${active ? ' working-on' : ''}`}>
        <ChatSwitcher chats={chats} canLeave={sendable} send={send} />
        {(chat.session?.status === 'crashed' || chat.session?.status === 'refused') && (
          <span className={`chat-status ${chat.session?.status ?? 'none'}`} title={chat.session?.model ?? undefined}>
            <i className="status-dot" />{chat.session.status === 'refused' ? 'hook off' : chat.session.status}
          </span>
        )}
        {chat.session?.permissionMode === 'plan' && (
          <span className="badge plan" title="The agent explores and plans, and changes no files until you approve a plan.">plan mode</span>
        )}
        <span className="spacer" />
        <div className="agent-view" role="radiogroup" aria-label="Agent view">
          <button role="radio" aria-checked={view === 'chat'} className={view === 'chat' ? 'on' : undefined} onClick={() => onView('chat')} title="CodeRay's chat">
            <Icon name="comment" size={13} />Chat
          </button>
          <button role="radio" aria-checked={view === 'terminal'} className={view === 'terminal' ? 'on' : undefined} onClick={() => onView('terminal')} title="Claude Code's own terminal interface: every slash command works">
            <Icon name="terminal" size={13} />Terminal
          </button>
        </div>
        {view === 'chat' && chat.session?.status === 'running' && <button className="chat-restart" onClick={() => send({ type: 'session.restart' })} title="Restart the agent" aria-label="Restart"><Icon name="restart" size={16} /></button>}
      </header>
      {dialog}
      {planDock}
      {chat.filter && (
        <div className="chat-filter" data-testid="chat-filter">
          <span>Filtered to {chat.filter.label}</span>
          <button onClick={onClearFilter}>Clear filter</button>
        </div>
      )}
      {view === 'terminal' && terminal}
      <div className="chat-log" hidden={view === 'terminal'}>
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
        {chat.draft !== '' && (
          <div className="turn">
            <div className="msg assistant rich"><MarkdownText text={chat.draft} /></div>
          </div>
        )}
        {working && <WorkingIndicator key={working.since} working={working} />}
        <div ref={end} />
      </div>
      {prompts.map((prompt, index) => (
        <details key={prompt.id} className="prompt gate" open={!(index === 0 && promptAnchored)} data-testid="gate-card">
          <summary>
            ⚠ Out of plan: {prompt.tool} <code>{targetLabel(promptTarget(prompt), prompt.summary)}</code>
            {index === 0 && promptAnchored ? ' · on the map' : ''}
          </summary>
          <PromptBody prompt={prompt} onAnswer={(answer) => onAnswerPrompt(prompt.id, answer)} />
        </details>
      ))}
      {chat.error && (
        <button className="chat-error" onClick={onDismissError}>{chat.error} ✕</button>
      )}
      {view === 'chat' && <footer
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
        {skillMenu && (skillMatches.length > 0
          ? <SkillMenu skills={skillMatches} active={skillActive} onPick={pickSkill} onHover={setSkillIndex} />
          : <SkillMenuEmpty />)}
        <div className="composer-box">
        <textarea
          ref={composer}
          rows={3}
          value={draft}
          onChange={(event) => changeDraft(event.target.value)}
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
          <button
            className="composer-action"
            onClick={() => { changeDraft('/'); composer.current?.focus(); }}
            disabled={draft !== '' && query === null}
            title={draft !== '' && query === null ? 'Clear the message to pick a skill' : 'Skills (type / to search)'}
            aria-label="Skills"
          >
            <Icon name="skill" size={18} />
          </button>
          <ModelControls current={chat.session ?? chats.sessions[0] ?? { modelChoice: null, effort: null }} models={chats.models} enabled={sendable} send={send} />
          <span className="spacer" />
          {!sendable && (
            <button className="composer-action stop" onClick={() => send({ type: 'chat.stop' })} disabled={!canStop(chat)} title={stop.title} aria-label={stop.label}>
              <Icon name="stop" size={18} />
              {stop.label !== 'Stop' && <span>{stop.label.slice('Stop'.length).trim()}</span>}
            </button>
          )}
          <button className="composer-action send" onClick={submit} disabled={!canSubmit} title="Send (Enter)" aria-label="Send">
            <Icon name="send" size={18} />
          </button>
        </div>
        </div>
        <div className="composer-usage"><BackgroundTasks tasks={tasks} send={send} /><UsageMeter usage={chat.usage} /></div>
      </footer>}
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
      <span className="tool-status">{STATUS_MARK[item.status]}</span> <b className={item.tool === 'Skill' ? 'skill-call' : undefined}>{item.tool === 'Skill' ? 'skill' : item.tool}</b>
      {label && <span className={`decision ${item.decision}`}> · {label}</span>}{item.recovered && <span className="muted"> · {RECOVERED}</span>} <span className="muted">{item.tool === 'Skill' ? `/${item.summary}` : item.summary}</span>
    </>
  );
  return (
    <div className={`tool ${item.status}`} data-item-id={item.id}>
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
