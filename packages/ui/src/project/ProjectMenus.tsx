import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { HubProject, RecentProject } from '@ide/protocol';
import { Icon } from '../layout/Icon';
import { Mono } from './Mono';
import { STATUS_LABEL, type ProjectStatus } from './project-status';
import { useDismiss } from './use-dismiss';

export interface MenuAnchor {
  left: number;
  bottom: number;
}

export const anchorOf = (element: HTMLElement): MenuAnchor => {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, bottom: rect.bottom };
};

// Arrow keys walk the rows; the first row takes focus when the menu opens.
function useRowKeys() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    const rows = [...(ref.current?.querySelectorAll<HTMLElement>('button') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();
    rows[(at + step + rows.length) % rows.length]?.focus();
  };
  return { ref, onKeyDown };
}

const place = (anchor: MenuAnchor, width: number) => ({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)), top: anchor.bottom + 6 });

export function NewMenu({ anchor, recent, mac, onRecent, onOpenFolder, onNewProject, onClone, onClose }: {
  anchor: MenuAnchor;
  recent: RecentProject[];
  mac: boolean;
  onRecent: (path: string) => void;
  onOpenFolder: () => void;
  onNewProject: () => void;
  onClone: () => void;
  onClose: () => void;
}) {
  const { ref, onKeyDown } = useRowKeys();
  useDismiss(ref, onClose);
  return (
    <div className="pmenu" role="menu" aria-label="Open project" ref={ref} onKeyDown={onKeyDown} style={place(anchor, 312)}>
      <div className="pmenu-h">Open project</div>
      <button className="pmenu-row" role="menuitem" onClick={onOpenFolder}><Icon name="folder" size={16} /><span>Open folder…</span><kbd style={{ marginLeft: 'auto' }}>{mac ? '⌘' : 'Ctrl+'}O</kbd></button>
      <button className="pmenu-row" role="menuitem" onClick={onClone}><Icon name="download" size={16} /><span>Clone repository…</span></button>
      <button className="pmenu-row" role="menuitem" onClick={onNewProject}><Icon name="folder-plus" size={16} /><span>New project…</span></button>
      {recent.length > 0 && <div className="pmenu-h">Recent</div>}
      {recent.map((item) => (
        <button key={item.path} className="pmenu-row" role="menuitem" title={item.path} onClick={() => onRecent(item.path)}>
          <Icon name="folder" size={16} />
          <span className="pm-name">{item.name}</span>
          <span className="pm-sub ppath"><bdi>{`‎${item.path}‎`}</bdi></span>
        </button>
      ))}
    </div>
  );
}

export function OverflowMenu({ anchor, projects, labels, statusOf, keyOf, onPick, onClose }: {
  anchor: MenuAnchor;
  projects: HubProject[];
  labels: Record<string, string>;
  statusOf: (id: string) => ProjectStatus;
  keyOf: (id: string) => string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const { ref, onKeyDown } = useRowKeys();
  useDismiss(ref, onClose);
  return (
    <div className="pmenu" role="menu" aria-label="More open projects" ref={ref} onKeyDown={onKeyDown} style={place(anchor, 312)}>
      <div className="pmenu-h">More open projects</div>
      {projects.map((project) => {
        const status = statusOf(project.id);
        const key = keyOf(project.id);
        return (
          <button key={project.id} className={`pmenu-row s-${status.kind}`} role="menuitem" onClick={() => onPick(project.id)}>
            <Mono name={project.name} root={project.root} kind={status.kind} />
            <span className="pm-name">{labels[project.id] ?? project.name}</span>
            <span className={`pm-sub plive ${status.kind}`} style={{ marginLeft: 'auto' }}>{STATUS_LABEL[status.kind]}</span>
            {key && <kbd>{key}</kbd>}
          </button>
        );
      })}
    </div>
  );
}
