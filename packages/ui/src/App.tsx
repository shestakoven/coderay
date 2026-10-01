import { ReactFlowProvider } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ClientMessage, ControlMode, GateAnswer, MapProgress, PlanAnswer, ProjectInfo, SettingsView } from '@ide/protocol';
import { ChatPanel } from './chat/ChatPanel';
import { chatReducer, initialChatState } from './chat/chat-state';
import { dialogEvent, eventFilePaths } from './history/dialog-state';
import { changeIndex, latestPlanVersion, historyReducer, initialHistoryState, type TimelineItem } from './history/history-state';
import { WatchdogDialog } from './history/WatchdogDialog';
import { DiffPanel } from './history/DiffPanel';
import { Timeline } from './history/Timeline';
import { DetailsPanel, type DetailsTab } from './map/DetailsPanel';
import { initialMapState, mapReducer } from './map/map-state';
import { MapView } from './map/MapView';
import { PlanOverlayContext, type PlanOverlay } from './plan/overlay';
import { PlanPanel } from './plan/PlanPanel';
import { initialPlanState, pendingPrompts, planMarks, planOnMap, planReducer, planTitle, waitsForUser } from './plan/plan-state';
import { C4View } from './c4/C4View';
import { describeMapStatus, describeProgress } from './map/status';
import { connect, fitsFrame, type Connection, type ConnectionStatus } from './net/socket';
import { hashToken, launchToken } from './net/token';
import { MODE_LABEL, MODE_TITLE, withMode } from './settings/policy-form';
import { initialModeSave, modeSaveReducer } from './settings/mode-save';
import { SettingsPanel, type SettingsResult } from './settings/SettingsPanel';
import { Icon } from './layout/Icon';
import { ActivityBar } from './layout/ActivityBar';
import { DetailsSlotContext } from './layout/DetailsSlot';
import { LeftPanel } from './layout/LeftPanel';
import { loadPanels, panelReducer, savePanels } from './layout/panel-state';
import { ComponentTree, FileTree } from './layout/Trees';
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
  const [plans, dispatchPlans] = useReducer(planReducer, initialPlanState);
  const [hist, dispatchHist] = useReducer(historyReducer, initialHistoryState);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [settingsResult, setSettingsResult] = useState<SettingsResult | null>(null);
  const [modeSave, dispatchModeSave] = useReducer(modeSaveReducer, initialModeSave);
  const modeRequest = useRef<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [view, setView] = useState<'c4' | 'components'>('c4');
  const [progress, setProgress] = useState<MapProgress>({ indexing: null, embedding: null });
  const connection = useRef<Connection | null>(null);
  const [focus, setFocus] = useState<{ componentIds: string[]; nonce: number } | null>(null);
  const [anchored, setAnchored] = useState(false);
  const [tab, setTab] = useState<DetailsTab>('details');
  const [highlight, setHighlight] = useState<Set<string>>(new Set());
  const [panels, dispatchPanels] = useReducer(panelReducer, undefined, () => loadPanels(storage()));
  const [detailsEl, setDetailsEl] = useState<HTMLElement | null>(null);
  const [chats, setChats] = useState<ChatList>({ activeId: null, sessions: [] });
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const [openDialog, setOpenDialog] = useState(false);
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
        case 'session.patch':
          dispatchChat({ type: 'patch', patch: message.patch });
          break;
        case 'settings.snapshot':
          setSettings(message.settings);
          break;
        case 'settings.result':
          setSettingsResult({ requestId: message.requestId, error: message.error });
          if (message.requestId === modeRequest.current) {
            modeRequest.current = null;
            dispatchModeSave(message.error ? { type: 'failed', message: message.error, now: Date.now() } : { type: 'saved' });
          }
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
        case 'sessions.snapshot':
          setChats({ activeId: message.activeId, sessions: message.sessions });
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
    return true;
  };

  const openSettings = (): void => {
    send({ type: 'settings.get' });
    setSettingsOpen(true);
  };
  useEffect(() => {
    if (modeSave.error === null) return;
    const timer = setTimeout(() => dispatchModeSave({ type: 'expire', now: Date.now() }), Math.max(0, modeSave.until - Date.now()));
    return () => clearTimeout(timer);
  }, [modeSave]);
  const saveMode = (mode: ControlMode) => {
    if (!settings) return;
    const requestId = crypto.randomUUID();
    modeRequest.current = requestId;
    send({ type: 'policy.save', requestId, level: 'project', policy: withMode(settings.policy, mode) });
  };
  const toReview = (settings?.servers.filter((server) => server.status === 'unapproved').length ?? 0)
    + (settings?.externalEdits.ideServers || settings?.externalEdits.trust ? 1 : 0)
    + (settings?.policy.externalEdits.ide || settings?.policy.externalEdits.project ? 1 : 0);

  useEffect(() => savePanels(storage(), panels), [panels]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
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
  const planIdentity = shown ? `${shown.id}@${shown.version}` : '';
  useEffect(() => {
    if (planIdentity) dispatchPanels({ type: 'plan-shown' });
  }, [planIdentity]);
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
    setView('components');
    setTab('changes');
  };
  const overlay: PlanOverlay = { marks, dimOthers: waitsForUser(shown), focus, prompt, prompts: pendingPrompts(plans.prompts), eventFiles, changes, highlight, answerPrompt, onAnchor: setAnchored };
  const c4 = snapshot?.c4 && snapshot.c4.containers.length > 0 ? snapshot.c4 : null;
  const showC4 = view === 'c4' && snapshot !== null && c4 !== null;
  const selectComponent = (id: string): void => {
    if (!showC4) dispatch({ type: 'select', id });
    focusComponents([id]);
  };
  const selectFile = (path: string): void => {
    const owner = snapshot?.files.find((file) => file.path === path)?.componentId;
    if (owner && !state.expanded.has(owner)) dispatch({ type: 'toggle', componentId: owner });
    setView('components');
    dispatch({ type: 'select', id: path });
  };
  const mapChips = [...describeProgress(progress), ...(snapshot ? describeMapStatus(snapshot.status) : [])];
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
      <div className={`app shell${panels.focus ? ' focus' : ''}`}>
        <header className="topbar">
          <button className="project-button" onClick={() => setOpenDialog(true)} title={projectInfo?.root ?? 'Open project…'}>
            <span className="project">{snapshot?.projectName ?? projectInfo?.name ?? '…'}</span>
            <Icon name="chevron-down" size={16} />
          </button>
          {c4 && (
            <span className="view-switch">
              <button className={view === 'c4' ? 'on' : ''} onClick={() => setView('c4')}>C4</button>
              <button className={view === 'components' ? 'on' : ''} onClick={() => setView('components')}>Components</button>
            </span>
          )}
          <span className="topbar-spacer" />
          {shown && (
            <button className={`chip plan-chip ${shown.status}`} onClick={() => dispatchPanels({ type: 'plan-shown' })}>
              {planTitle(shown)}
            </button>
          )}
          {settings && (
            <label className="chip mode" title={MODE_TITLE}>
              Out-of-plan writes{' '}
              <select
                value={settings.policy.effective.mode}
                onChange={(event) => saveMode(event.target.value as ControlMode)}
              >
                {(['A', 'B', 'C'] as const).map((mode) => <option key={mode} value={mode}>{MODE_LABEL[mode]}</option>)}
              </select>
              {Object.hasOwn(settings.policy.project, 'mode') ? ' (this project)' : ''}
              {modeSave.error !== null && <span className="warn" role="alert"> {modeSave.error}</span>}
            </label>
          )}
        </header>
        <div className="workspace">
          <ActivityBar
            left={panels.left}
            right={panels.right}
            bottom={panels.bottom}
            focus={panels.focus}
            onToggle={(panel) => dispatchPanels({ type: 'toggle', panel })}
            onFocus={() => dispatchPanels({ type: 'focus' })}
            onSettings={openSettings}
            onOpenProject={() => setOpenDialog(true)}
            badge={toReview}
          />
          {panels.left && (
            <LeftPanel
              tab={panels.leftTab}
              onTab={(tab) => dispatchPanels({ type: 'left-tab', tab })}
              hasPlan={shown !== null}
              plan={shown && (
                <PlanPanel
                  key={planKey}
                  plan={shown}
                  snapshot={snapshot}
                  open
                  onAnswer={answerPlan}
                  onFocusStep={(index) => focusComponents(marks.stepComponents[index] ?? [])}
                />
              )}
              components={snapshot ? <ComponentTree snapshot={snapshot} changes={changes} marks={marks} selected={state.selected} onSelectComponent={selectComponent} onSelectFile={selectFile} /> : <div className="empty muted">Waiting for the map…</div>}
              files={snapshot ? <FileTree snapshot={snapshot} changes={changes} selected={state.selected} onSelectFile={selectFile} /> : <div className="empty muted">Waiting for the map…</div>}
            />
          )}
          <main className="map-area">
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
          <aside className="right-panel" hidden={!showRight} aria-label="Agent and details">
            <div className="seg" role="tablist">
              <button role="tab" aria-selected={panels.rightTab === 'agent'} className={panels.rightTab === 'agent' ? 'on' : ''} onClick={() => dispatchPanels({ type: 'right-tab', tab: 'agent' })}>Agent</button>
              <button role="tab" aria-selected={panels.rightTab === 'details'} className={panels.rightTab === 'details' ? 'on' : ''} onClick={() => dispatchPanels({ type: 'right-tab', tab: 'details' })}>Details</button>
            </div>
            <div className="right-body" hidden={panels.rightTab !== 'agent'}>
              <ChatPanel
                chat={chat}
                chats={chats}
                send={send}
                onClearFilter={() => dispatchChat({ type: 'filter', filter: null })}
                onDismissError={() => dispatchChat({ type: 'dismiss-error' })}
                prompts={pendingPrompts(plans.prompts)}
                dialog={watchdog && <WatchdogDialog key={watchdog.id} event={watchdog} diffs={hist.results} send={send} requestDiff={requestDiff} />}
                promptAnchored={anchored}
                onAnswerPrompt={(promptId, answer) => send({ type: 'gate.answer', promptId, answer })}
                onFocusTargets={(paths) => {
                  const owners = new Set(snapshot?.files.filter((file) => paths.includes(file.path)).flatMap((file) => (file.componentId ? [file.componentId] : [])));
                  if (owners.size > 0) focusComponents([...owners]);
                }}
                planRow={shown ? { text: `${planTitle(shown)} · on the map`, onOpen: () => dispatchPanels({ type: 'plan-shown' }) } : null}
              />
            </div>
            <div className="right-body details-slot" hidden={panels.rightTab !== 'details'} ref={setDetailsEl}>
              <div className="empty muted">Select a component or file on the map to see its details and changes.</div>
            </div>
          </aside>
        </div>
        {!panels.focus && (
          <Timeline plans={plans.plans} latestPlan={latestPlan} history={hist.history} results={hist.results} chat={chat} send={send} onSelect={selectTimelineItem} open={panels.bottom} onToggle={() => dispatchPanels({ type: 'toggle', panel: 'bottom' })} />
        )}
        <footer className="statusbar">
          <span className={`conn ${status}`}><i className="dot" />{status === 'open' ? 'core connected' : status}</span>
          {snapshot && <span>{snapshot.files.length} files · {snapshot.components.length} components</span>}
          {mapChips.map((chip) => (
            <span key={chip.text} className={`chip ${chip.tone}`} title={chip.title}>{chip.text}</span>
          ))}
          <span className="statusbar-spacer" />
          {projectInfo && <span className="mono" title="Project root">{projectInfo.root}</span>}
        </footer>
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

