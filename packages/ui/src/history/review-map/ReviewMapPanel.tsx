import type { PlanView, ReviewEvidence, ReviewGraph, ReviewLink, ReviewLinkState, ReviewPart, ReviewPartStatus } from '@ide/protocol';
import { Icon } from '../../layout/Icon';
import { KindIcon } from '../../plan-flow/FlowCard';
import { KIND_ACCENT, OP_CLASS } from '../../plan-flow/flow-style';
import { fileOutsidePlan, type Target } from './review-map-model';
import type { MapQuestion } from './review-map-questions';
import { linkLabel } from './ReviewMapLink';

const STATUS: Record<ReviewPartStatus, string> = {
  created: 'Created by the agent',
  modified: 'Changed by the agent',
  deleted: 'Removed by the agent',
  untouched: 'Not changed',
  missing: 'Planned, but nothing changed',
};

const LINK: Record<ReviewLinkState, { label: string; tone: string }> = {
  existing: { label: 'Present before and after', tone: '' },
  new: { label: 'New in the code', tone: 'ok' },
  removed: { label: 'Removed from the code', tone: 'bad' },
  unplanned: { label: 'New in the code, not in the plan', tone: 'warn' },
  missing: { label: 'Planned, but not in the code', tone: 'warn' },
  broken: { label: 'Still imported, but the target was removed', tone: 'bad' },
};

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

function Evidence({ items }: { items: ReviewEvidence[] }) {
  return (
    <ul className="rm-evidence">
      {items.map((item) => (
        <li key={`${item.path}:${item.line}`}>
          <span className="rm-where">{item.path}:{item.line}</span>
          <code>{item.text}</code>
        </li>
      ))}
    </ul>
  );
}

function Ask({ question, onAsk, onOpenChat }: { question: MapQuestion | undefined; onAsk: () => void; onOpenChat: () => void }) {
  const asked = question !== undefined && question.sentAt !== null;
  return (
    <>
      {question !== undefined && (
        <div className={`rm-thread ${asked ? 'asked' : 'draft'}`}>
          <p className="rm-q-text"><Icon name="help" size={12} />{question.text}</p>
          {asked ? (
            <p className="rm-a-wait">
              <span>Asked. The answer is in the chat.</span>
              <button type="button" className="pf-link on" onClick={onOpenChat}>Open chat</button>
            </p>
          ) : (
            <p className="rm-a-wait">Not sent yet.</p>
          )}
        </div>
      )}
      <div className="pf-acts">
        <button type="button" className={`pf-act rm-ask${question !== undefined ? ' on' : ''}`} onClick={onAsk}>
          <Icon name="help" size={13} />
          <span>{question === undefined ? 'Ask about this' : asked ? 'Ask again' : 'Edit the question'}</span>
          <kbd>Q</kbd>
        </button>
      </div>
    </>
  );
}

export interface ReviewMapPanelProps {
  graph: ReviewGraph;
  plan: PlanView | null;
  target: Target;
  question: MapQuestion | undefined;
  reviewed: ReadonlySet<string>;
  selectedPath: string | null;
  onAccept: (paths: string[]) => void;
  onOpenFile: (path: string) => void;
  onAsk: () => void;
  onOpenChat: () => void;
  onClose: () => void;
}

function PartDetails({ graph, plan, part, question, reviewed, selectedPath, onAccept, onOpenFile, onAsk, onOpenChat, onClose }: Omit<ReviewMapPanelProps, 'target'> & { part: ReviewPart }) {
  const ordered = plan === null ? [] : [...plan.steps].sort((a, b) => a.order - b.order);
  const steps = ordered.flatMap((step, index) => (part.steps.includes(step.key) ? [{ step, no: index + 1 }] : []));
  const around = graph.links.filter((link) => link.from === part.id || link.to === part.id);
  const titleOf = (id: string): string => graph.parts.find((candidate) => candidate.id === id)?.title ?? id;
  return (
    <section className="pf-detail" data-testid="review-map-details">
      <div className="pf-detail-head">
        <span className="pf-detail-title" style={{ ['--acc' as string]: KIND_ACCENT.module }}>
          <KindIcon kind="module" />
          {part.title}
        </span>
        <button type="button" className="pf-x" onClick={onClose} aria-label="Close">{'×'}</button>
      </div>
      <div className="pf-detail-sub">Part {'·'} {STATUS[part.status]}</div>
      {part.outside && <p className="rm-state warn">Not in the plan: no step lists {part.files.length === 1 ? 'this file' : 'these files'}.</p>}
      {part.broken.length > 0 && (
        <>
          <p className="rm-state bad">{plural(part.broken.length, 'import')} in this part {part.broken.length === 1 ? 'points' : 'point'} at a removed file.</p>
          <div className="pf-detail-label">Broken imports</div>
          <Evidence items={part.broken} />
        </>
      )}
      {steps.map(({ step, no }) => (
        <p className="pf-detail-why" key={step.key}><b>Step {no}.</b> {step.rationale === '' ? step.title : step.rationale}</p>
      ))}
      {part.files.length > 0 && (
        <>
          <div className="pf-detail-label">What was done</div>
          <ul className="rm-done">
            {part.files.map((file) => {
              const on = reviewed.has(file.path);
              return (
                <li key={file.path}>
                  <button type="button" className={`rm-check${on ? ' on' : ''}`} aria-pressed={on} aria-label={on ? `${file.path} is reviewed` : `Mark ${file.path} as reviewed`} title={on ? 'Reviewed' : 'Accept the file'} disabled={on} onClick={() => onAccept([file.path])}>
                    {on && <Icon name="check" size={11} />}
                  </button>
                  <span className="rm-done-body">
                    <button type="button" className={`rm-file${selectedPath === file.path ? ' on' : ''}`} onClick={() => onOpenFile(file.path)} title={file.path}>
                      <b className={OP_CLASS[file.op]}>{file.op}</b> <span className="pf-path">{file.path}</span>
                    </button>
                    <span className="pf-note">
                      {file.added > 0 && <i className="op-add">+{file.added}</i>} {file.removed > 0 && <i className="op-del">−{file.removed}</i>}
                      {fileOutsidePlan(file, plan !== null) && <span className="rm-file-outside">outside the plan</span>}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {around.length > 0 && (
        <>
          <div className="pf-detail-label">Connections in the code</div>
          <ul className="rm-conn">
            {around.map((link) => (
              <li key={`${link.from}>${link.to}`} className={LINK[link.state].tone}>
                <span>{link.from === part.id ? '→' : '←'} {titleOf(link.from === part.id ? link.to : link.from)}</span>
                <span className="pf-note">{linkLabel(link)}{link.state !== 'existing' && link.state !== 'new' ? ` · ${link.state}` : ''}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <Ask question={question} onAsk={onAsk} onOpenChat={onOpenChat} />
    </section>
  );
}

function LinkDetails({ graph, plan, link, question, onAsk, onOpenChat, onClose }: Pick<ReviewMapPanelProps, 'graph' | 'plan' | 'question' | 'onAsk' | 'onOpenChat' | 'onClose'> & { link: ReviewLink }) {
  const titleOf = (id: string): string => graph.parts.find((part) => part.id === id)?.title ?? id;
  const meta = LINK[link.state];
  const sentence = link.state === 'new' && plan !== null ? 'New in the code, as planned' : meta.label;
  return (
    <section className="pf-detail" data-testid="review-map-details">
      <div className="pf-detail-head">
        <span className="pf-detail-title"><Icon name="link" size={14} /> {linkLabel(link)}</span>
        <button type="button" className="pf-x" onClick={onClose} aria-label="Close">{'×'}</button>
      </div>
      <div className="pf-detail-sub">{titleOf(link.from)} {'→'} {titleOf(link.to)}</div>
      <p className={`rm-state ${meta.tone}`}>{sentence}</p>
      {link.state !== 'existing' && (
        <>
          <div className="pf-detail-label">Where it is in the code</div>
          {link.evidence.length === 0 ? (
            <p className="rm-none">{link.state === 'missing' ? 'Nothing in the code does this yet.' : 'The line of the import could not be found.'}</p>
          ) : (
            <>
              <Evidence items={link.evidence} />
              {link.count > link.evidence.length && <p className="rm-none">{plural(link.count, 'file')} in all.</p>}
            </>
          )}
        </>
      )}
      <Ask question={question} onAsk={onAsk} onOpenChat={onOpenChat} />
    </section>
  );
}

export function ReviewMapPanel(props: ReviewMapPanelProps) {
  const { graph, target } = props;
  if (target.t === 'link') {
    const link = graph.links.find((candidate) => candidate.from === target.from && candidate.to === target.to);
    return link === undefined ? null : <LinkDetails {...props} link={link} />;
  }
  const part = graph.parts.find((candidate) => candidate.id === target.id);
  return part === undefined ? null : <PartDetails {...props} part={part} />;
}
