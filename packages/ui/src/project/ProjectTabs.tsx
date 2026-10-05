import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import type { HubProject } from '@ide/protocol';
import { Icon } from '../layout/Icon';
import { Mono } from './Mono';
import type { ProjectStatus, StatusKind } from './project-status';
import { dropIndex, reorderVisible, shiftFor } from './tab-drag';
import { fitTabs, TAB, type TabFit } from './tabs-fit';

interface Props {
  projects: HubProject[];
  labels: Record<string, string>;
  activeId: string | null;
  statusOf: (id: string) => ProjectStatus;
  mac: boolean;
  newOpen: boolean;
  overflowOpen: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (ids: string[]) => void;
  onNew: (anchor: HTMLElement) => void;
  onOverflow: (anchor: HTMLElement, hidden: string[]) => void;
}

const NEW_WIDTH = 34;
const HINT_MIN_BAR = 520;
const WORST: StatusKind[] = ['attention', 'error', 'working'];

export function ProjectTabs({ projects, labels, activeId, statusOf, mac, newOpen, overflowOpen, onActivate, onClose, onReorder, onNew, onOverflow }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<TabFit>({ mode: 'full', visible: projects.map((_, index) => index), hidden: [] });
  const activeIndex = Math.max(0, projects.findIndex((project) => project.id === activeId));
  const hint = projects.length === 1;
  const [drag, setDrag] = useState<{ id: string; dx: number; to: number } | null>(null);
  const start = useRef<{ id: string; from: number; x: number; slot: number; moved: boolean } | null>(null);
  const justDragged = useRef(false);
  const command = mac ? '⌘' : 'Ctrl+';

  useLayoutEffect(() => {
    const element = wrap.current;
    if (!element) return;
    const measure = () => {
      const inset = Number.parseFloat(getComputedStyle(element).paddingLeft) || 0;
      const room = element.clientWidth - inset - NEW_WIDTH - 10 - (hint && element.clientWidth > HINT_MIN_BAR ? 190 : 0);
      setFit(fitTabs(projects.length, activeIndex, room));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [projects.length, activeIndex, hint]);

  const visible = fit.visible.map((index) => projects[index]).filter((project): project is HubProject => project !== undefined);
  const hidden = fit.hidden.map((index) => projects[index]).filter((project): project is HubProject => project !== undefined);
  const hiddenWorst = WORST.find((kind) => hidden.some((project) => statusOf(project.id).kind === kind));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>, id: string, from: number) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.ptab-x')) return;
    start.current = { id, from, x: event.clientX, slot: event.currentTarget.offsetWidth + TAB.gap, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const origin = start.current;
    if (!origin) return;
    const dx = event.clientX - origin.x;
    if (!origin.moved && Math.abs(dx) < 5) return;
    origin.moved = true;
    setDrag({ id: origin.id, dx, to: dropIndex(origin.from, dx, origin.slot, visible.length) });
  };
  const onPointerUp = () => {
    const origin = start.current;
    start.current = null;
    if (!origin?.moved || !drag) {
      setDrag(null);
      return;
    }
    justDragged.current = true;
    setTimeout(() => { justDragged.current = false; }, 0);
    if (drag.to !== origin.from) onReorder(reorderVisible(projects.map((project) => project.id), visible.map((project) => project.id), origin.from, drag.to));
    setDrag(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step !== 0) {
      const next = visible[index + step];
      if (next) {
        event.preventDefault();
        onActivate(next.id);
        (event.currentTarget.parentElement?.children[index + step] as HTMLElement | undefined)?.focus();
      }
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const target = visible[index];
      if (target) onActivate(target.id);
    }
  };

  return (
    <div className="pbar-wrap" ref={wrap}>
      <div className="ptab-list" role="tablist" aria-label="Open projects" onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        {visible.map((project, index) => {
          const status = statusOf(project.id);
          const active = project.id === activeId;
          const compact = fit.mode !== 'full' && !active;
          const dragging = drag?.id === project.id;
          const shift = drag && !dragging ? shiftFor(index, visible.findIndex((candidate) => candidate.id === drag.id), drag.to, (start.current?.slot ?? TAB.full)) : 0;
          const label = labels[project.id] ?? project.name;
          const key = projects.indexOf(project) < 9 ? `${mac ? '⌘' : 'Ctrl'} ${projects.indexOf(project) + 1}` : '';
          return (
            <div
              key={project.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={`ptab s-${status.kind}${active ? ' on' : ''}${compact ? ' compact' : ''}${dragging ? ' dragging' : ''}`}
              style={{ transform: dragging ? `translateX(${drag.dx}px)` : shift !== 0 ? `translateX(${shift}px)` : undefined } as CSSProperties}
              data-project-id={project.id}
              data-tip={label}
              data-sub={`${status.line}${projects.length > 1 ? '\nDrag to reorder' : ''}`}
              data-keys={key}
              onClick={() => { if (!justDragged.current) onActivate(project.id); }}
              onAuxClick={(event) => { if (event.button === 1 && projects.length > 1) onClose(project.id); }}
              onPointerDown={(event) => onPointerDown(event, project.id, index)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              <span className="ptab-bg" />
              <Mono name={project.name} root={project.root} kind={status.kind} />
              <span className="project">{label}</span>
              {projects.length > 1 && (
                <button className="ptab-x" tabIndex={-1} aria-label={`Close ${label}`} data-tip="Close project" data-keys={`${mac ? '⌘' : 'Ctrl'} W`} onClick={(event) => { event.stopPropagation(); onClose(project.id); }}>
                  <Icon name="close" size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {hidden.length > 0 && (
        <button data-menu-anchor className={`pbar-ovf${overflowOpen ? ' on' : ''}`} aria-haspopup="menu" aria-expanded={overflowOpen} data-tip={`${hidden.length} more projects`} onClick={(event) => onOverflow(event.currentTarget, hidden.map((project) => project.id))}>
          <Icon name="chevron-down" size={14} />
          <span>{hidden.length}</span>
          {hiddenWorst && <i className={`pdot ${hiddenWorst}`} />}
        </button>
      )}
      <button data-menu-anchor className={`pbar-new${newOpen ? ' on' : ''}`} aria-label="Open project" aria-haspopup="menu" aria-expanded={newOpen} data-tip="Open project" data-keys={`${mac ? '⌘' : 'Ctrl'} T`} onClick={(event) => onNew(event.currentTarget)}>
        <Icon name="plus" size={16} />
      </button>
      {hint && <span className="pbar-hint">Open another project<kbd>{command}T</kbd></span>}
    </div>
  );
}
