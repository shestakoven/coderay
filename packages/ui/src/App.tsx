import { ReactFlowProvider } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ClientMessage, GateAnswer, MapProgress, PlanAnswer, ProjectInfo, SettingsView } from '@ide/protocol';
import { ErrorBoundary } from './layout/ErrorBoundary';
import { ChatPanel } from './chat/ChatPanel';
import { canSend, chatReducer, initialChatState } from './chat/chat-state';
import { dialogEvent, eventFilePaths } from './history/dialog-state';
import { changeIndex, latestPlanVersion, historyReducer, initialHistoryState, type TimelineItem } from './history/history-state';
import { WatchdogDialog } from './history/WatchdogDialog';
import { DiffPanel } from './history/DiffPanel';
import { Timeline } from './history/Timeline';
import { DetailsPanel, type DetailsTab } from './map/DetailsPanel';
import { initialMapState, mapReducer } from './map/map-state';
import { MapView } from './map/MapView';
import { MapActivity } from './map/MapActivity';
import { PlanOverlayContext, type PlanOverlay } from './plan/overlay';
import { PlanPanel } from './plan/PlanPanel';
import { PlanDock } from './plan/PlanDock';
import { chimeKey, finishedWorking, playChime, playDone, type Activity } from './plan/chime';
import { initialPlanState, pendingPrompts, planMarks, planOnMap, planReducer, waitsForUser } from './plan/plan-state';
import { C4View } from './c4/C4View';
import { describeMapStatus, describeProgress } from './map/status';
import { connect, fitsFrame, type Connection, type ConnectionStatus } from './net/socket';
import { hashToken, launchToken } from './net/token';
import { SettingsPanel, type SettingsResult } from './settings/SettingsPanel';
import { Icon } from './layout/Icon';
import { DetailsSlotContext } from './layout/DetailsSlot';
import { LeftPanel, LEFT_TABS } from './layout/LeftPanel';
import { loadPanels, panelReducer, savePanels } from './layout/panel-state';
import { Resizer } from './layout/Resizer';
import { ComponentTree, FileTree } from './layout/Trees';
import { clampSize, DEFAULT_SIZES, LIMITS, loadSizes, saveSizes, type PanelSizes, type SizedPanel } from './layout/sizes';
import { TerminalPanel } from './terminal/TerminalPanel';
import { TerminalHub, type TerminalTab } from './terminal/terminal-hub';
import { OpenProjectDialog, useOpenProject } from './project/OpenProjectDialog';
import type { ChatList } from './chat/ChatSwitcher';

const storage = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

const typing = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  return element !== null && (/^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) || element.isContentEditable);
};

export function App() {
  const token = useMemo(launchToken, []);
  const [state, dispatch] = useReducer(mapReducer, initialMapState);
  const [chat, dispatchChat] = useReducer(chatReducer, initialChatState);
  const stoppedByUser = useRef(false);
  const [plans, dispatchPlans] = useReducer(planReducer, initialPlanState);
  const [hist, dispatchHist] = useReducer(historyReducer, initialHistoryState);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [settingsResult, setSettingsResult] = useState<SettingsResult | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [progress, setProgress] = useState<MapProgress>({ indexing: null, embedding: null });
  const connection = useRef<Connection | null>(null);
  const [focus, setFocus] = useState<{ componentIds: string[]; nonce: number } | null>(null);
  const [anchored, setAnchored] = useState(false);
  const [tab, setTab] = useState<DetailsTab>('details');
  const [highlight, setHighlight] = useState<Set<string>>(new Set());
  const [panels, dispatchPanels] = useReducer(panelReducer, undefined, () => loadPanels(storage()));
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([]);
  const sendRef = useRef<(message: ClientMessage) => boolean>(() => false);
  const hub = useMemo(() => new TerminalHub((message) => sendRef.current(message), setTerminalTabs), []);
  const [sizes, setSizes] = useState<PanelSizes>(() => loadSizes(storage()));
  const [chats, setChats] = useState<ChatList>({ activeId: null, sessions: [], models: [] });
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const [openDialog, setOpenDialog] = useState(false);
  const [detailsEl, setDetailsEl] = useState<HTMLElement | null>(null);
  const openProject = useOpenProject();
  const switching = useRef({ requested: false, dropped: false });
  const knownRoot = useRef<string | null>(null);
  const snapshot = state.snapshot;
  const shown = useMemo(() => planOnMap(plans.plans), [plans.plans]);
  const marks = useMemo(() => planMarks(shown, snapshot), [shown, snapshot]);

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
        case 'map.snapshot':
          dispatch({ type: 'snapshot', snapshot: message.snapshot });
          break;
        case 'map.progress':
          setProgress(message.progress);
          break;
        case 'session.snapshot':
          dispatchChat({ type: 'snapshot', state: message.state });
          break;
        case 'session.delta':
          dispatchChat({ type: 'delta', text: message.text });
          break;
        case 'session.patch':
          dispatchChat({ type: 'patch', patch: message.patch });
          break;
        case 'settings.snapshot':
          setSettings(message.settings);
          break;
        case 'settings.result':
          setSettingsResult({ requestId: message.requestId, error: message.error });
          break;
        case 'plans.snapshot':
          dispatchPlans({ type: 'plans', plans: message.plans });
          break;
        case 'gate.snapshot':
          dispatchPlans({ type: 'prompts', prompts: message.prompts });
          break;
        case 'history.snapshot':
          dispatchHist({ type: 'snapshot', history: message.history });
          break;
        case 'history.patch':
          dispatchHist({ type: 'patch', patch: message.patch });
          break;
        case 'history.result':
          dispatchHist({ type: 'result', requestId: message.requestId, error: message.error, diff: message.diff, preview: message.preview });
          break;
        case 'terminal.snapshot':
          hub.restore(message.terminals);
          break;
        case 'terminal.opened':
          hub.opened(message.terminal);
          break;
        case 'terminal.output':
          hub.output(message.id, message.data);
          break;
        case 'terminal.exit':
          hub.exited(message.id, message.code);
          break;
        case 'terminal.closed':
          hub.closed(message.id);
          break;
        case 'sessions.snapshot':
          setChats((previous) => ({ ...previous, activeId: message.activeId, sessions: message.sessions }));
          break;
        case 'models.snapshot':
          setChats((previous) => ({ ...previous, models: message.models }));
          break;
        case 'project.info':
          if (knownRoot.current !== null && knownRoot.current !== message.info.root) location.reload();
          knownRoot.current = message.info.root;
          setProjectInfo(message.info);
          break;
        case 'fs.list.result':
          openProject.dispatch({ type: 'server', message });
          break;
        case 'project.open.result':
          openProject.dispatch({ type: 'server', message });
          if (message.error === null) switching.current.requested = true;
          break;
        case 'error':
          dispatchChat({ type: 'error', message: message.message });
          break;
      }
    }, (next) => {
      setStatus(next);
      if (next === 'open') connection.current?.send({ type: 'models.list' });
      if (!switching.current.requested) return;
      if (next === 'closed') switching.current.dropped = true;
      else if (next === 'open' && switching.current.dropped) location.reload();
    });
    connection.current = current;
    return () => current.close();
  }, [token]);

  if (!token) {
    return <div className="no-token">Open the address the IDE core printed when it started: it carries this launch's access token.</div>;
  }

  const send = (message: ClientMessage): boolean => {
    if (!fitsFrame(message)) {
      dispatchChat({ type: 'error', message: 'This message is too long to send: the limit is 64 KiB.' });
      return false;
    }
    if (!connection.current?.send(message)) {
      dispatchChat({ type: 'error', message: 'Not connected to the IDE core.' });
      return false;
    }
    if (message.type === 'chat.stop') stoppedByUser.current = true;
    return true;
  };

  sendRef.current = (message) => connection.current?.send(message) ?? false;

  const openSettings = (): void => {
    send({ type: 'settings.get' });
    setSettingsOpen(true);
  };
  const toReview = (settings?.servers.filter((server) => server.status === 'unapproved').length ?? 0)
    + (settings?.externalEdits.ideServers || settings?.externalEdits.trust ? 1 : 0)
    + (settings?.policy.externalEdits.ide || settings?.policy.externalEdits.project ? 1 : 0);

  useEffect(() => savePanels(storage(), panels), [panels]);
  useEffect(() => saveSizes(storage(), sizes), [sizes]);
  const terminalOpenRef = useRef(false);
  terminalOpenRef.current = panels.bottom && panels.bottomTab === 'terminal';
  const toggleTerminal = (): void => {
    if (terminalOpenRef.current) dispatchPanels({ type: 'toggle', panel: 'bottom' });
    else dispatchPanels({ type: 'bottom-tab', tab: 'terminal' });
  };
  const toggleTerminalRef = useRef(toggleTerminal);
  toggleTerminalRef.current = toggleTerminal;
  const resize = (panel: SizedPanel, size: number): void => {
    const other = panel === 'left' ? (panels.right ? sizes.right : 0) : panel === 'right' ? (panels.left ? sizes.left : 0) : 0;
    const next = clampSize(panel, size, { viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, otherSideWidth: other });
    setSizes((current) => (current[panel] === next ? current : { ...current, [panel]: next }));
  };
  const resetSize = (panel: SizedPanel): void => setSizes((current) => ({ ...current, [panel]: DEFAULT_SIZES[panel] }));
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === '`') {
        event.preventDefault();
        toggleTerminalRef.current();
        return;
      }
      if (typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'f') dispatchPanels({ type: 'focus' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onDetailsShown = useCallback(() => dispatchPanels({ type: 'node-selected' }), []);
  const onDetailsHidden = useCallback(() => dispatchPanels({ type: 'selection-cleared' }), []);
  const detailsSlot = useMemo(() => ({ element: detailsEl, onShown: onDetailsShown, onHidden: onDetailsHidden }), [detailsEl, onDetailsShown, onDetailsHidden]);

  const planKey = shown ? `${shown.id}@${shown.version}@${shown.status}` : '';
  const waitingPlan = chimeKey(shown);
  useEffect(() => {
    if (waitingPlan) playChime();
  }, [waitingPlan]);
  const activity: Activity = { chatId: chat.session?.id ?? null, busy: !canSend(chat) };
  const lastActivity = useRef<Activity | null>(null);
  useEffect(() => {
    if (finishedWorking(lastActivity.current, activity, stoppedByUser.current)) playDone();
    if (!activity.busy) stoppedByUser.current = false;
    lastActivity.current = activity;
  }, [activity.chatId, activity.busy]);
  const prompt = pendingPrompts(plans.prompts)[0] ?? null;
  const answerPlan = (answer: PlanAnswer) => {
    if (shown) send({ type: 'plan.answer', planId: shown.id, version: shown.version, answer });
  };
  const answerPrompt = (answer: GateAnswer) => {
    if (prompt) send({ type: 'gate.answer', promptId: prompt.id, answer });
  };
  const focusComponents = (componentIds: string[]) => setFocus({ componentIds, nonce: Date.now() });
  const watchdogId = dialogEvent(hist.history.events)?.id ?? null;
  const attentionId = prompt?.id ?? watchdogId;
  useEffect(() => {
    if (attentionId) dispatchPanels({ type: 'attention' });
  }, [attentionId]);
  const eventFiles = useMemo(() => eventFilePaths(hist.history.events), [hist.history.events]);
  const watchdog = dialogEvent(hist.history.events);
  const requestDiff = (path: string, before: string | null, after: string | null): string | null => {
    const requestId = crypto.randomUUID();
    return send({ type: 'history.diff', requestId, path, before, after }) ? requestId : null;
  };
  const changes = useMemo(() => changeIndex(hist.history, snapshot), [hist.history, snapshot]);
  const latestPlan = useMemo(() => (shown ? latestPlanVersion(plans.plans, shown.id) : null), [plans.plans, shown]);
  const selectTimelineItem = (item: TimelineItem): void => {
    const paths = new Set(item.files);
    const owners = new Set(snapshot?.files.filter((file) => paths.has(file.path)).flatMap((file) => (file.componentId ? [file.componentId] : [])));
    setHighlight(new Set([...paths, ...owners]));
    if (owners.size > 0) focusComponents([...owners]);
    const first = item.files[0];
    if (first === undefined) return;
    const owner = snapshot?.files.find((file) => file.path === first)?.componentId;
    if (owner && !state.expanded.has(owner)) dispatch({ type: 'toggle', componentId: owner });
    dispatch({ type: 'select', id: first });
    setTab('changes');
  };
  const overlay: PlanOverlay = { marks, dimOthers: waitsForUser(shown), focus, prompt, prompts: pendingPrompts(plans.prompts), eventFiles, changes, highlight, answerPrompt, onAnchor: setAnchored };
  const c4 = snapshot?.c4 && snapshot.c4.containers.length > 0 ? snapshot.c4 : null;
  const [componentsView, setComponentsView] = useState(false);
  const showC4 = snapshot !== null && c4 !== null && !componentsView;
  const selectComponent = (id: string): void => {
    if (!showC4) dispatch({ type: 'select', id });
    focusComponents([id]);
  };
  const selectFile = (path: string): void => {
    const owner = snapshot?.files.find((file) => file.path === path)?.componentId;
    if (showC4) {
      if (owner) focusComponents([owner]);
      return;
    }
    if (owner && !state.expanded.has(owner)) dispatch({ type: 'toggle', componentId: owner });
    dispatch({ type: 'select', id: path });
  };
  const mapChips = [...describeProgress(progress), ...(snapshot ? describeMapStatus(snapshot.status) : [])].filter((chip) => chip.tone !== 'ok');
  const mapDetails = (
    <DetailsPanel
      state={state}
      tab={tab}
      onTab={setTab}
      changes={(nodeId) => (
        <DiffPanel
          nodeId={nodeId}
          history={hist.history}
          plans={plans.plans}
          snapshot={snapshot}
          filter={chat.filter}
          onFilter={(filter) => dispatchChat({ type: 'filter', filter })}
          diffs={hist.results}
          requestDiff={requestDiff}
        />
      )}
    />
  );
  const showRight = panels.right;
  return (
    <DetailsSlotContext.Provider value={detailsSlot}>
      <div className={`app shell${panels.focus ? ' focus' : ''}`} style={{ '--left-w': `${sizes.left}px`, '--right-w': `${sizes.right}px`, '--bottom-h': `${sizes.bottom}px` } as React.CSSProperties}>
        <header className="topbar">
          <button className="project-button" onClick={() => setOpenDialog(true)} title={projectInfo?.root ?? 'Open project…'}>
            <span className="project">{snapshot?.projectName ?? projectInfo?.name ?? '…'}</span>
            <Icon name="chevron-down" size={16} />
          </button>
          {c4 && (
            <span className="view-switch">
              <button className={!componentsView ? 'on' : ''} onClick={() => setComponentsView(false)}>C4</button>
              <button className={componentsView ? 'on' : ''} onClick={() => setComponentsView(true)}>Components</button>
            </span>
          )}
          <div className="seg topbar-tabs" role="tablist">
            {LEFT_TABS.map(({ key, label }) => (
              <button key={key} role="tab" aria-selected={panels.leftTab === key && panels.left} className={panels.leftTab === key && panels.left ? 'on' : ''} onClick={() => dispatchPanels({ type: 'left-tab', tab: key })}>{label}</button>
            ))}
          </div>
          <span className="topbar-spacer" />
          <div className="seg topbar-tabs" role="tablist">
            <button role="tab" aria-selected={panels.rightTab === 'agent'} className={panels.rightTab === 'agent' ? 'on' : ''} onClick={() => dispatchPanels({ type: 'right-tab', tab: 'agent' })}>Agent</button>
            <button role="tab" aria-selected={panels.rightTab === 'plan'} className={panels.rightTab === 'plan' ? 'on' : ''} onClick={() => dispatchPanels({ type: 'right-tab', tab: 'plan' })}>
              Plan
              {shown !== null && <span className="seg-dot" aria-label="has a plan" />}
            </button>
          </div>
          <div className="topbar-actions">
            <button className={panels.left ? 'on' : ''} onClick={() => dispatchPanels({ type: 'toggle', panel: 'left' })} title="Project panel" aria-pressed={panels.left}><Icon name="panel-left" size={17} /></button>
            <button className={panels.right ? 'on' : ''} onClick={() => dispatchPanels({ type: 'toggle', panel: 'right' })} title="Agent and details" aria-pressed={panels.right}><Icon name="panel-right" size={17} /></button>
            <button className={panels.focus ? 'on' : ''} onClick={() => dispatchPanels({ type: 'focus' })} title="Focus: map only (F)" aria-pressed={panels.focus}><Icon name="maximize" size={17} /></button>
            <button className="with-badge" onClick={openSettings} title="Settings">
              <Icon name="settings" size={17} />
              {toReview > 0 && <b>{toReview}</b>}
            </button>
          </div>
        </header>
        <div className="workspace">
          <LeftPanel
            hidden={!panels.left}
            tab={panels.leftTab}
            components={snapshot ? <ComponentTree snapshot={snapshot} changes={changes} marks={marks} selected={state.selected} onSelectComponent={selectComponent} onSelectFile={selectFile} /> : <div className="empty muted">Waiting for the map…</div>}
            detailsRef={setDetailsEl}
            files={snapshot ? <FileTree snapshot={snapshot} changes={changes} selected={state.selected} onSelectFile={selectFile} /> : <div className="empty muted">Waiting for the map…</div>}
          />
          {panels.left && <Resizer orientation="vertical" label="Resize project panel" value={sizes.left} min={LIMITS.left.min} max={LIMITS.left.max} grow={1} onResize={(size) => resize('left', size)} onReset={() => resetSize('left')} />}
          <main className="map-area">
            <MapActivity progress={progress} status={snapshot?.status ?? null} />
            <div className="map-regroup">
              <button type="button" onClick={() => send({ type: 'map.regroup' })}>Regroup</button>
            </div>
            <PlanOverlayContext.Provider value={overlay}>
              {showC4 && snapshot && c4 ? (
                <ReactFlowProvider>
                  <C4View snapshot={snapshot} model={c4} />
                </ReactFlowProvider>
              ) : (
                <ReactFlowProvider>
                  <MapView state={state} dispatch={dispatch} />
                </ReactFlowProvider>
              )}
              {!showC4 && mapDetails}
            </PlanOverlayContext.Provider>
          </main>
          {showRight && <Resizer orientation="vertical" label="Resize agent panel" value={sizes.right} min={LIMITS.right.min} max={LIMITS.right.max} grow={-1} onResize={(size) => resize('right', size)} onReset={() => resetSize('right')} />}
          <aside className="right-panel" hidden={!showRight} aria-label="Agent and details">
            <div className="right-body" hidden={panels.rightTab !== 'agent'}>
              <ErrorBoundary label="The chat">
                <ChatPanel
                  chat={chat}
                  chats={chats}
                  send={send}
                  onClearFilter={() => dispatchChat({ type: 'filter', filter: null })}
                  onDismissError={() => dispatchChat({ type: 'dismiss-error' })}
                  prompts={pendingPrompts(plans.prompts)}
                  dialog={watchdog && <WatchdogDialog key={watchdog.id} event={watchdog} diffs={hist.results} send={send} requestDiff={requestDiff} />}
                  planDock={shown && waitsForUser(shown) && (
                    <PlanDock key={planKey} plan={shown} snapshot={snapshot} onAnswer={answerPlan} onFocusStep={(index) => focusComponents(marks.stepComponents[index] ?? [])} />
                  )}
                  promptAnchored={anchored}
                  onAnswerPrompt={(promptId, answer) => send({ type: 'gate.answer', promptId, answer })}
                  onFocusTargets={(paths) => {
                    const owners = new Set(snapshot?.files.filter((file) => paths.includes(file.path)).flatMap((file) => (file.componentId ? [file.componentId] : [])));
                    if (owners.size > 0) focusComponents([...owners]);
                  }}
                />
              </ErrorBoundary>
            </div>
            <div className="right-body" hidden={panels.rightTab !== 'plan'}>
              {shown && !waitsForUser(shown) ? (
                <PlanPanel
                  key={planKey}
                  plan={shown}
                  snapshot={snapshot}
                  open
                  onAnswer={answerPlan}
                  onFocusStep={(index) => focusComponents(marks.stepComponents[index] ?? [])}
                />
              ) : (
                <div className="empty muted">{shown ? 'The plan is waiting for your answer above the chat.' : 'No plan yet. When the agent proposes one, it appears above the chat and on the map.'}</div>
              )}
            </div>
          </aside>
        </div>
        <div className="bottom-area" hidden={panels.focus}>
          {panels.bottom && <Resizer orientation="horizontal" label="Resize timeline" value={sizes.bottom} min={LIMITS.bottom.min} max={LIMITS.bottom.max} grow={-1} onResize={(size) => resize('bottom', size)} onReset={() => resetSize('bottom')} />}
          <Timeline
            plans={plans.plans}
            latestPlan={latestPlan}
            history={hist.history}
            results={hist.results}
            chat={chat}
            send={send}
            onSelect={selectTimelineItem}
            open={panels.bottom}
            onToggle={() => dispatchPanels({ type: 'toggle', panel: 'bottom' })}
            tab={panels.bottomTab}
            onTab={(tab) => dispatchPanels({ type: 'bottom-tab', tab })}
            terminalCount={terminalTabs.length}
            trailing={(
              <>
                <span className={`conn ${status}`}><i className="dot" />{status === 'open' ? 'core connected' : status}</span>
                {mapChips.map((chip) => (
                  <span key={chip.text} className={`chip ${chip.tone}`} title={chip.title}>{chip.text}</span>
                ))}
              </>
            )}
            terminal={<TerminalPanel hub={hub} tabs={terminalTabs} visible={panels.bottom && panels.bottomTab === 'terminal' && !panels.focus} />}
          />
        </div>
        {openDialog && (
          <OpenProjectDialog info={projectInfo} controller={openProject} send={send} onClose={() => { setOpenDialog(false); openProject.dispatch({ type: 'reset' }); }} />
        )}
        {settingsOpen && (
          <SettingsPanel
            settings={settings}
            lastResult={settingsResult}
            sessionServers={chat.mcpServers}
            send={send}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </div>
    </DetailsSlotContext.Provider>
  );
}

