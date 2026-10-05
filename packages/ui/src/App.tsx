import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ClientMessage, ProjectInfo } from '@ide/protocol';
import { Tooltips } from './layout/Tooltips';
import { TopBar } from './layout/TopBar';
import { playChime } from './plan/chime';
import { connect, type Connection, type ConnectionStatus } from './net/socket';
import { hashToken, launchToken } from './net/token';
import { OpenProjectDialog, useOpenProject } from './project/OpenProjectDialog';
import { CloseProjectDialog, NewProjectDialog, ProjectNote } from './project/ProjectDialogs';
import { anchorOf, NewMenu, OverflowMenu, type MenuAnchor } from './project/ProjectMenus';
import { ProjectPalette } from './project/ProjectPalette';
import { ProjectTabs } from './project/ProjectTabs';
import { ProjectView } from './project/ProjectView';
import { Notices } from './project/Notices';
import { noticesReducer } from './project/notice-state';
import type { PaletteAction } from './project/palette-model';
import { IDLE, noticeFor, STARTING, type ProjectStatus } from './project/project-status';
import { activeProject, afterClose, cycleTarget, initialProjects, jumpTarget, projectsReducer, tabLabels } from './project/projects-state';
import { isMac, matchShortcut } from './project/shortcuts';
import { StartScreen } from './project/StartScreen';
import { initialStart, startReducer } from './project/start-state';

const SETTLE_MS = 2500;
type Dialog = 'open' | 'create' | 'clone' | null;
type Menu = { kind: 'new'; anchor: MenuAnchor } | { kind: 'overflow'; anchor: MenuAnchor; ids: string[] } | null;

export function App() {
  const token = useMemo(launchToken, []);
  const mac = useMemo(isMac, []);
  const [projects, dispatchProjects] = useReducer(projectsReducer, initialProjects);
  const [notices, dispatchNotices] = useReducer(noticesReducer, []);
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const control = useRef<Connection | null>(null);
  const openProject = useOpenProject();
  const [start, dispatchStart] = useReducer(startReducer, initialStart);
  const switching = useRef({ requested: false, dropped: false });
  const knownRoot = useRef<string | null | undefined>(undefined);
  const [menu, setMenu] = useState<Menu>(null);
  const [palette, setPalette] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  const [settingsRequest, setSettingsRequest] = useState(0);
  const [badges, setBadges] = useState<Record<string, number>>({});
  const seen = useRef<Record<string, ProjectStatus>>({});
  const born = useRef<Record<string, number>>({});
  const live = useRef(projects);
  live.current = projects;
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;
  const hub = projects.mode === 'hub';

  const send = useCallback((message: ClientMessage): boolean => control.current?.send(message) ?? false, []);
  const notify = useCallback((id: string, title: string, body: string, kind: 'attention' | 'done' | 'error') => {
    dispatchNotices({ type: 'add', notice: { id: crypto.randomUUID(), projectId: id, kind, title, body } });
    if (kind === 'attention') playChime();
    if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body });
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      if (hashToken(location.hash)) location.reload();
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (!token) return;
    const current = connect(token, (message) => {
      switch (message.type) {
        case 'hub.snapshot':
          dispatchProjects({ type: 'hub', hub: message.hub });
          break;
        case 'project.info':
          if (knownRoot.current !== undefined && knownRoot.current !== message.info.root) location.reload();
          knownRoot.current = message.info.root;
          dispatchProjects({ type: 'legacy', info: message.info });
          break;
        case 'fs.list.result':
          openProject.dispatch({ type: 'server', message });
          break;
        case 'project.open.result':
          openProject.dispatch({ type: 'server', message });
          if (message.error === null) {
            if (live.current.mode === 'hub') {
              openProject.dispatch({ type: 'reset' });
              dispatchStart({ type: 'done' });
              setDialog(null);
              setMenu(null);
              setPalette(false);
            } else switching.current.requested = true;
          } else if (dialogRef.current !== 'open' && live.current.projects.length > 0) {
            openProject.dispatch({ type: 'reset' });
            dispatchNotices({ type: 'add', notice: { id: crypto.randomUUID(), projectId: null, kind: 'error', title: 'Could not open the project', body: message.error } });
          }
          break;
        case 'project.create.result':
        case 'project.clone.result':
          dispatchStart({ type: 'server', message });
          if (message.error === null) {
            if (live.current.mode === 'hub') {
              openProject.dispatch({ type: 'reset' });
              dispatchStart({ type: 'done' });
              setDialog(null);
            } else switching.current.requested = true;
          }
          break;
        case 'project.clone.progress':
          dispatchStart({ type: 'server', message });
          break;
        case 'project.close.result':
          if (message.error === null) switching.current.requested = true;
          break;
      }
    }, (next) => {
      setConnection(next);
      if (!switching.current.requested) return;
      if (next === 'closed') switching.current.dropped = true;
      else if (next === 'open' && switching.current.dropped) location.reload();
    });
    control.current = current;
    return () => current.close();
  }, [token, openProject.dispatch]);

  const labels = useMemo(() => tabLabels(projects.projects), [projects.projects]);
  const keyOf = useCallback((id: string): string => {
    const at = live.current.projects.findIndex((project) => project.id === id);
    return at >= 0 && at < 9 ? `${mac ? '⌘' : 'Ctrl+'}${at + 1}` : '';
  }, [mac]);
  const statusOf = useCallback((id: string): ProjectStatus => {
    const project = live.current.projects.find((candidate) => candidate.id === id);
    if (project?.state === 'starting') return STARTING;
    if (project?.state === 'failed') return { kind: 'error', line: project.error ?? 'The IDE core stopped.' };
    return live.current.status[id] ?? IDLE;
  }, []);

  const onStatus = useCallback((id: string, next: ProjectStatus) => {
    const previous = seen.current[id];
    seen.current[id] = next;
    born.current[id] ??= Date.now();
    dispatchProjects({ type: 'status', id, status: next });
    const project = live.current.projects.find((candidate) => candidate.id === id);
    const background = id !== live.current.activeId || !document.hasFocus();
    const notice = project ? noticeFor(previous, next, tabLabels(live.current.projects)[id] ?? project.name) : null;
    // Right after a view connects its first snapshots arrive: a question still waiting is news, an old crash or finish is not.
    const settling = Date.now() - (born.current[id] ?? 0) < SETTLE_MS;
    if (notice && background && !(settling && notice.kind !== 'attention')) notify(id, notice.title, notice.body, notice.kind);
    else dispatchNotices({ type: 'status', projectId: id, kind: next.kind });
  }, [notify]);
  const coreStates = useRef<Record<string, string>>({});
  useEffect(() => {
    for (const project of projects.projects) {
      const before = coreStates.current[project.id];
      coreStates.current[project.id] = project.state;
      if (before === 'running' && project.state === 'failed' && (project.id !== projects.activeId || !document.hasFocus())) {
        notify(project.id, `${tabLabels(projects.projects)[project.id] ?? project.name} stopped`, project.error ?? 'The IDE core stopped.', 'error');
      }
    }
  }, [projects.projects, projects.activeId, notify]);
  const onBadge = useCallback((id: string, count: number) => setBadges((current) => (current[id] === count ? current : { ...current, [id]: count })), []);

  const activate = useCallback((id: string) => {
    if (live.current.activeId === id) return;
    dispatchProjects({ type: 'activate', id });
    dispatchNotices({ type: 'shown', projectId: id });
    if (live.current.mode === 'hub') control.current?.send({ type: 'hub.activate', id });
  }, []);
  useEffect(() => {
    if (projects.activeId) dispatchNotices({ type: 'shown', projectId: projects.activeId });
  }, [projects.activeId]);
  useEffect(() => {
    const ids = new Set(projects.projects.map((project) => project.id));
    for (const id of Object.keys(seen.current)) if (!ids.has(id)) delete seen.current[id];
    for (const id of Object.keys(born.current)) if (!ids.has(id)) delete born.current[id];
  }, [projects.projects]);

  const closeProject = useCallback((id: string) => {
    const state = live.current;
    if (state.mode === 'legacy') {
      control.current?.send({ type: 'project.close', requestId: crypto.randomUUID() });
      return;
    }
    const target = afterClose(state, id);
    if (target && target !== id && state.activeId === id) activate(target);
    control.current?.send({ type: 'hub.close', requestId: crypto.randomUUID(), id });
    dispatchProjects({ type: 'remove', id });
    dispatchNotices({ type: 'gone', projectId: id });
  }, [activate]);
  const requestClose = useCallback((id: string) => {
    const kind = statusOf(id).kind;
    if (kind === 'working' || kind === 'attention') setConfirmClose(id);
    else closeProject(id);
  }, [statusOf, closeProject]);

  const openPath = useCallback((path: string) => {
    const requestId = crypto.randomUUID();
    if (control.current?.send({ type: 'project.open', requestId, path })) openProject.dispatch({ type: 'open', requestId });
    setMenu(null);
    setPalette(false);
  }, [openProject.dispatch]);

  const act = useCallback((action: PaletteAction) => {
    setPalette(false);
    setMenu(null);
    if (action === 'open-folder') setDialog('open');
    else if (action === 'clone') setDialog('clone');
    else if (action === 'new') setDialog('create');
    else if (live.current.activeId) requestClose(live.current.activeId);
  }, [requestClose]);

  const openNewMenu = useCallback(() => {
    const button = document.querySelector<HTMLElement>('.pbar-new');
    if (button) setMenu({ kind: 'new', anchor: anchorOf(button) });
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const shortcut = matchShortcut(event, mac);
      if (!shortcut) return;
      const state = live.current;
      if (state.projects.length === 0 || confirmClose !== null) return;
      event.preventDefault();
      switch (shortcut.type) {
        case 'palette':
          setMenu(null);
          setPalette((open) => !open);
          break;
        case 'new':
          setPalette(false);
          openNewMenu();
          break;
        case 'open-folder':
          setPalette(false);
          setMenu(null);
          setDialog('open');
          break;
        case 'close':
          if (state.activeId) requestClose(state.activeId);
          break;
        case 'jump': {
          const target = jumpTarget(state, shortcut.key);
          if (target) activate(target);
          break;
        }
        case 'cycle': {
          const target = cycleTarget(state, shortcut.dir);
          if (target) activate(target);
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mac, confirmClose, activate, requestClose, openNewMenu]);

  const shownName = activeProject(projects)?.name;
  useEffect(() => {
    document.title = shownName ? `${shownName} · AI Control IDE` : 'AI Control IDE';
  }, [shownName]);

  const info: ProjectInfo = useMemo(() => ({ root: activeProject(projects)?.root ?? null, name: activeProject(projects)?.name ?? '', home: projects.home, recent: projects.recent.filter((item) => !projects.projects.some((project) => project.root === item.path)) }), [projects]);

  if (!token) {
    return <div className="no-token">Open the address the IDE core printed when it started: it carries this launch's access token.</div>;
  }
  if (projects.mode === 'pending') {
    return connection === 'closed'
      ? <div className="no-token">Cannot reach the IDE core. It may have stopped; start it again.</div>
      : <div className="app boot" aria-busy="true" />;
  }
  if (projects.projects.length === 0) {
    return <StartScreen info={info} status={connection} browse={openProject} start={start} dispatchStart={dispatchStart} send={send} />;
  }

  const active = activeProject(projects);
  const closing = confirmClose ? projects.projects.find((project) => project.id === confirmClose) : undefined;
  return (
    <div className="app shell">
      <TopBar
        mac={mac}
        reviewCount={active ? (badges[active.id] ?? 0) : 0}
        onSettings={() => setSettingsRequest((count) => count + 1)}
        tabs={(
          <ProjectTabs
            projects={projects.projects}
            labels={labels}
            activeId={projects.activeId}
            statusOf={statusOf}
            mac={mac}
            newOpen={menu?.kind === 'new'}
            overflowOpen={menu?.kind === 'overflow'}
            onActivate={activate}
            onClose={requestClose}
            onReorder={(ids) => {
              dispatchProjects({ type: 'order', ids });
              if (hub) control.current?.send({ type: 'hub.order', ids });
            }}
            onNew={(anchor) => setMenu((current) => (current?.kind === 'new' ? null : { kind: 'new', anchor: anchorOf(anchor) }))}
            onOverflow={(anchor, ids) => setMenu((current) => (current?.kind === 'overflow' ? null : { kind: 'overflow', anchor: anchorOf(anchor), ids }))}
          />
        )}
      />
      <div className="views">
        {projects.projects.map((project) => (project.state === 'running' && (project.port !== null || projects.mode === 'legacy')
          ? (
            <ProjectView
              key={project.id}
              project={project}
              token={project.token ?? token}
              url={project.port !== null ? `ws://127.0.0.1:${project.port}/ws` : undefined}
              active={project.id === projects.activeId}
              settingsRequest={settingsRequest}
              onStatus={onStatus}
              onBadge={onBadge}
            />
          )
          : project.id === projects.activeId && (
            <ProjectNote
              key={project.id}
              project={project}
              onRestart={() => control.current?.send({ type: 'hub.restart', requestId: crypto.randomUUID(), id: project.id })}
              onClose={() => closeProject(project.id)}
            />
          )))}
      </div>
      {menu?.kind === 'new' && (
        <NewMenu
          anchor={menu.anchor}
          recent={projects.recent.filter((item) => !projects.projects.some((project) => project.root === item.path)).slice(0, 5)}
          mac={mac}
          onRecent={openPath}
          onOpenFolder={() => act('open-folder')}
          onNewProject={() => act('new')}
          onClone={() => act('clone')}
          onClose={() => setMenu(null)}
        />
      )}
      {menu?.kind === 'overflow' && (
        <OverflowMenu
          anchor={menu.anchor}
          projects={projects.projects.filter((project) => menu.ids.includes(project.id))}
          labels={labels}
          statusOf={statusOf}
          keyOf={keyOf}
          onPick={(id) => { setMenu(null); activate(id); }}
          onClose={() => setMenu(null)}
        />
      )}
      {palette && (
        <ProjectPalette
          projects={projects.projects}
          labels={labels}
          recent={projects.recent}
          recency={projects.recency}
          mac={mac}
          statusOf={statusOf}
          keyOf={keyOf}
          onSwitch={(id) => { setPalette(false); activate(id); }}
          onRecent={openPath}
          onAction={act}
          onClose={() => setPalette(false)}
        />
      )}
      {dialog === 'open' && (
        <OpenProjectDialog info={info} controller={openProject} send={send} onClose={() => { setDialog(null); openProject.dispatch({ type: 'reset' }); }} onCloseProject={hub ? undefined : () => send({ type: 'project.close', requestId: crypto.randomUUID() })} />
      )}
      {(dialog === 'create' || dialog === 'clone') && (
        <NewProjectDialog initial={dialog} browse={openProject} start={start} dispatchStart={dispatchStart} send={send} onClose={() => { setDialog(null); dispatchStart({ type: 'done' }); openProject.dispatch({ type: 'reset' }); }} />
      )}
      {closing && (
        <CloseProjectDialog
          name={labels[closing.id] ?? closing.name}
          kind={statusOf(closing.id).kind}
          onCancel={() => setConfirmClose(null)}
          onConfirm={() => { setConfirmClose(null); closeProject(closing.id); }}
        />
      )}
      <Notices notices={notices} projects={projects.projects} keyOf={keyOf} onOpen={(id) => { activate(id); dispatchNotices({ type: 'shown', projectId: id }); }} onDismiss={(id) => dispatchNotices({ type: 'dismiss', id })} />
      <Tooltips />
    </div>
  );
}
