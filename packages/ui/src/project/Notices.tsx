import { useLayoutEffect, useState, type CSSProperties } from 'react';
import type { HubProject } from '@ide/protocol';
import { Icon } from '../layout/Icon';
import { Mono } from './Mono';
import type { NoticeItem } from './notice-state';

const WIDTH = 348;
const DONE_MS = 8000;

interface Props {
  notices: NoticeItem[];
  projects: HubProject[];
  keyOf: (id: string) => string;
  onOpen: (projectId: string) => void;
  onDismiss: (id: string) => void;
}

export function Notices({ notices, projects, keyOf, onOpen, onDismiss }: Props) {
  const [rects, setRects] = useState<Record<string, DOMRect>>({});
  useLayoutEffect(() => {
    const measure = () => {
      const next: Record<string, DOMRect> = {};
      for (const notice of notices) {
        if (notice.kind !== 'attention' || notice.projectId === null) continue;
        const tab = document.querySelector<HTMLElement>(`[data-project-id="${CSS.escape(notice.projectId)}"]`);
        if (tab) next[notice.id] = tab.getBoundingClientRect();
      }
      setRects(next);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [notices]);
  useLayoutEffect(() => {
    const timers = notices.filter((notice) => notice.kind === 'done').map((notice) => window.setTimeout(() => onDismiss(notice.id), DONE_MS));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [notices, onDismiss]);

  const card = (notice: NoticeItem, anchor: DOMRect | undefined) => {
    const project = projects.find((candidate) => candidate.id === notice.projectId);
    const left = anchor ? Math.max(10, Math.min(anchor.left + anchor.width / 2 - 60, window.innerWidth - WIDTH - 10)) : 0;
    const style: CSSProperties | undefined = anchor ? { left, top: anchor.bottom + 9 } : undefined;
    return (
      <div key={notice.id} className={`ptoast ${notice.kind}${anchor ? ' anchored' : ''}`} style={style} role="alert">
        {anchor && <i className="caret" style={{ left: anchor.left + anchor.width / 2 - left - 5 }} />}
        {project && <Mono name={project.name} root={project.root} size={30} />}
        <div className="pt-body">
          <div className="pt-title">{notice.title}</div>
          <div className="pt-text">{notice.body}</div>
          {notice.projectId !== null && notice.kind !== 'error' && (
            <div className="pt-actions">
              {notice.kind === 'attention' ? (
                <>
                  <button className="pbtn primary" onClick={() => onOpen(notice.projectId!)}>Open project{keyOf(notice.projectId) && <kbd>{keyOf(notice.projectId)}</kbd>}</button>
                  <button className="pbtn" onClick={() => onDismiss(notice.id)}>Later</button>
                </>
              ) : (
                <button className="pbtn" onClick={() => onOpen(notice.projectId!)}>Open project</button>
              )}
            </div>
          )}
        </div>
        <button className="pt-x" aria-label="Dismiss" onClick={() => onDismiss(notice.id)}><Icon name="close" size={13} /></button>
      </div>
    );
  };
  const stacked = notices.filter((notice) => rects[notice.id] === undefined);
  return (
    <>
      {notices.filter((notice) => rects[notice.id] !== undefined).map((notice) => card(notice, rects[notice.id]))}
      {stacked.length > 0 && <div className="ptoasts">{stacked.map((notice) => card(notice, undefined))}</div>}
    </>
  );
}
