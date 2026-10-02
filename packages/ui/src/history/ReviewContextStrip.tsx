import { Icon } from '../layout/Icon';
import type { ReviewContext } from './review-context';
import { Kbd } from './ReviewParts';

const STATUS: Record<string, string> = { running: '…', ok: '✓', error: '✗', rejected: '⊘', unfinished: '–' };

interface Props {
  context: ReviewContext;
  open: boolean;
  onToggle: () => void;
  onJump: (toolUseId: string) => void;
}

export function ReviewContextStrip({ context, open, onToggle, onJump }: Props) {
  const calls = context.tools.length;
  return (
    <section className={`rv-context${open ? ' open' : ''}`} aria-label="Why this change exists">
      <button className="rv-context-bar" aria-expanded={open} onClick={onToggle} title="Why this change exists (i)">
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        <span className="rv-context-title">{context.title}</span>
        {!open && calls > 0 && <span className="rv-context-meta">{calls} tool {calls === 1 ? 'call' : 'calls'}</span>}
        <Kbd>i</Kbd>
      </button>
      <div className="rv-context-body" inert={!open}>
        <div className="rv-context-inner"><div className="rv-context-scroll">
          {context.reason && <p className="rv-reason"><Icon name="alert" size={14} />{context.reason}{context.decision ? ` ${context.decision}` : ''}</p>}
          {context.rationale && <p className="rv-why"><span>Why</span>{context.rationale}</p>}
          {context.summary && (
            <p className="rv-why"><span>Summary</span>{context.summary.text ?? (context.summary.pending ? 'Being written…' : 'No summary yet.')}</p>
          )}
          {calls > 0 && (
            <ul className="rv-tools" aria-label="Tool calls that made this change">
              {context.tools.map((tool) => (
                <li key={tool.id}>
                  <button className="rv-tool" disabled={!tool.inChat} onClick={() => onJump(tool.id)} title={tool.inChat ? 'Show this call in the chat' : 'This call is no longer in the chat'}>
                    <span className={`rv-tool-status ${tool.status ?? 'unknown'}`}>{tool.status ? STATUS[tool.status] : '·'}</span>
                    <b>{tool.tool}</b>
                    <span className="rv-tool-summary">{tool.summary}</span>
                    {tool.inChat && <span className="rv-tool-go"><Icon name="arrow-up-right" size={13} />Show in chat</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!context.reason && !context.rationale && !context.summary && calls === 0 && <p className="rv-why muted">Nothing more is known about where this change came from.</p>}
        </div></div>
      </div>
    </section>
  );
}
