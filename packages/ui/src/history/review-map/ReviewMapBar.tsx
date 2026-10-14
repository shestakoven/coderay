import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../layout/Icon';
import type { MapQuestion } from './review-map-questions';

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

export interface ReviewMapBarProps {
  reviewed: number;
  files: number;
  unsent: MapQuestion[];
  outdated: ReadonlySet<string>;
  asked: number;
  text: string;
  open: boolean;
  onOpen: (open: boolean) => void;
  onRemove: (id: string) => void;
  onReset: () => void;
  onClearAsked: () => void;
  onSend: () => void;
  onOpenChat: () => void;
}

export function ReviewMapBar({ reviewed, files, unsent, outdated, asked, text, open, onOpen, onRemove, onReset, onClearAsked, onSend, onOpenChat }: ReviewMapBarProps) {
  const [raw, setRaw] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(event.target as Node)) onOpen(false);
    };
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [open, onOpen]);

  if (unsent.length === 0) {
    if (asked > 0) {
      return (
        <div className="pf-bar" data-testid="review-map-bar" data-phase="asked">
          <span className="rm-bar-asked"><Icon name="check" size={12} /></span>
          <span className="pf-bar-text"><b>{plural(asked, 'question')} sent</b><span className="rm-bar-more"> · answers are in the chat</span></span>
          <button type="button" className="pf-btn ghost" onClick={onOpenChat}>Open chat</button>
          <button type="button" className="pf-btn ghost" onClick={onClearAsked} title="Take the Asked marks off the map">Clear</button>
          <span className="pf-bar-sep rm-bar-more" />
          <span className="pf-bar-hint">{reviewed} of {files} files reviewed</span>
        </div>
      );
    }
    return (
      <div className="pf-bar" data-testid="review-map-bar" data-phase="idle">
        <span className="pf-bar-dot" />
        <span className="pf-bar-text"><b>{reviewed} of {files}</b> files reviewed</span>
        <span className="pf-bar-hint"><Icon name="info" size={12} /> Point at a part or a link to ask about it</span>
      </div>
    );
  }
  return (
    <div className="pf-bar dirty" ref={box} data-testid="review-map-bar" data-phase="dirty">
      {open && (
        <div className="pf-draft" data-testid="review-map-draft">
          <div className="pf-draft-head">
            <span>What the agent will receive</span>
            <button type="button" className={`pf-link${raw ? ' on' : ''}`} onClick={() => setRaw(!raw)}>{raw ? 'List' : 'Message'}</button>
          </div>
          {raw ? (
            <pre className="pf-draft-raw">{text}</pre>
          ) : (
            <div className="pf-draft-group">
              <div className="pf-draft-label">Questions</div>
              {unsent.map((question) => (
                <div className="pf-draft-row ask" key={question.id}>
                  <span className="pf-draft-ic"><Icon name="help" size={12} /></span>
                  <span className="pf-draft-body">
                    <span className="pf-draft-title">
                      {question.title}
                      {outdated.has(question.id) && <span className="rm-outdated" title="This part or link is no longer in the review. The question is still sent.">Outdated</span>}
                    </span>
                    <span className="pf-draft-detail">{question.text}</span>
                    {question.where !== '' && <span className="pf-draft-detail rm-mono">{question.where}</span>}
                  </span>
                  <button type="button" className="pf-draft-x" aria-label="Remove this question" onClick={() => onRemove(question.id)}><Icon name="close" size={12} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <button type="button" className={`pf-changes${open ? ' on' : ''}`} onClick={() => onOpen(!open)} aria-expanded={open} data-testid="review-map-questions">
        <span className="pf-count">{unsent.length}</span>
        <span>{unsent.length === 1 ? 'question' : 'questions'}</span>
        <Icon name={open ? 'minus' : 'plus'} size={11} />
      </button>
      <button type="button" className="pf-link" onClick={onReset}>Reset</button>
      <span className="pf-bar-sep" />
      <button type="button" className="pf-btn primary" onClick={onSend} data-testid="review-map-send">Ask the agent <kbd>⌘↵</kbd></button>
    </div>
  );
}
