import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { HubProject, RecentProject } from '@ide/protocol';
import { Icon, type IconName } from '../layout/Icon';
import { formatAgo } from './start-state';
import { Mono } from './Mono';
import { initialRow, paletteGroups, type PaletteAction, type PaletteRow } from './palette-model';
import { STATUS_LABEL, type ProjectStatus } from './project-status';

const ACTION_ICON: Record<PaletteAction, IconName> = { 'open-folder': 'folder', clone: 'download', new: 'folder-plus', close: 'close' };

const mark = (text: string, query: string): ReactNode => {
  const q = query.trim();
  const at = q === '' ? -1 : text.toLowerCase().indexOf(q.toLowerCase());
  return at < 0 ? text : <>{text.slice(0, at)}<u>{text.slice(at, at + q.length)}</u>{text.slice(at + q.length)}</>;
};

export function ProjectPalette({ projects, labels, recent, recency, mac, statusOf, keyOf, onSwitch, onRecent, onAction, onClose }: {
  projects: HubProject[];
  labels: Record<string, string>;
  recent: RecentProject[];
  recency: string[];
  mac: boolean;
  statusOf: (id: string) => ProjectStatus;
  keyOf: (id: string) => string;
  onSwitch: (id: string) => void;
  onRecent: (path: string) => void;
  onAction: (action: PaletteAction) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => paletteGroups({ projects, labels, recent, query, mac }), [projects, labels, recent, query, mac]);
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const [selected, setSelected] = useState(() => initialRow(groups, recency, ''));
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const now = Date.now();
  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    list.current?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  const choose = (row: PaletteRow | undefined): void => {
    if (!row) return;
    if (row.kind === 'open') onSwitch(row.project.id);
    else if (row.kind === 'recent') onRecent(row.recent.path);
    else onAction(row.action);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') onClose();
    else if (event.key === 'ArrowDown') setSelected((at) => Math.min(rows.length - 1, at + 1));
    else if (event.key === 'ArrowUp') setSelected((at) => Math.max(0, at - 1));
    else if (event.key === 'Enter') choose(rows[selected]);
    else return;
    event.preventDefault();
  };
  let index = -1;
  return (
    <>
      <div className="pscrim" onMouseDown={onClose} />
      <div className="ppal" role="dialog" aria-modal="true" aria-label="Switch project" onKeyDown={onKeyDown}>
        <div className="ppal-in">
          <Icon name="search" size={18} />
          <input ref={input} value={query} onChange={(event) => { setQuery(event.target.value); setSelected(0); }} placeholder="Switch project, open a folder…" spellCheck={false} autoComplete="off" aria-label="Project" />
        </div>
        <div className="ppal-list" ref={list} role="listbox">
          {groups.map((group) => (
            <div key={group.title}>
              <div className="ppal-g">{group.title}</div>
              {group.rows.map((row) => {
                index += 1;
                const at = index;
                const cls = `ppal-row${selected === at ? ' sel' : ''}`;
                const hover = () => setSelected(at);
                if (row.kind === 'open') {
                  const status = statusOf(row.project.id);
                  return (
                    <button key={row.project.id} className={`${cls} s-${status.kind}`} role="option" aria-selected={selected === at} onMouseMove={hover} onClick={() => choose(row)}>
                      <Mono name={row.project.name} root={row.project.root} kind={status.kind} size={20} />
                      <span className="pn">{mark(row.label, query)}</span>
                      <span className="pf" />
                      <span className={`pst plive ${status.kind}`}>{STATUS_LABEL[status.kind]}</span>
                      {keyOf(row.project.id) && <kbd>{keyOf(row.project.id)}</kbd>}
                    </button>
                  );
                }
                if (row.kind === 'recent') {
                  return (
                    <button key={row.recent.path} className={cls} role="option" aria-selected={selected === at} onMouseMove={hover} onClick={() => choose(row)} title={row.recent.path}>
                      <Icon name="folder" size={16} />
                      <span className="pn">{mark(row.recent.name, query)}</span>
                      <span className="pa ppath"><bdi>{`‎${row.recent.path}‎`}</bdi></span>
                      <span className="ptm">{formatAgo(now, row.recent.openedAt)}</span>
                      <span className="prk">Open<kbd>↵</kbd></span>
                    </button>
                  );
                }
                return (
                  <button key={row.action} className={cls} role="option" aria-selected={selected === at} onMouseMove={hover} onClick={() => choose(row)}>
                    <Icon name={ACTION_ICON[row.action]} size={16} />
                    <span className="pn">{row.label}</span>
                    <span className="pf" />
                    {row.keys && <kbd>{row.keys}</kbd>}
                  </button>
                );
              })}
            </div>
          ))}
          {rows.length === 0 && <div className="ppal-empty">No project matches “{query.trim()}”</div>}
        </div>
        <div className="ppal-foot"><span><kbd>↑</kbd><kbd>↓</kbd>move</span><span><kbd>↵</kbd>open</span><span><kbd>{mac ? '⌘' : 'Ctrl+'}1</kbd>–<kbd>9</kbd>jump</span><span><kbd>esc</kbd>close</span></div>
      </div>
    </>
  );
}
