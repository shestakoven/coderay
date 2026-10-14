import { ReactFlowProvider } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AGENT_TERMINAL_ID, type ClientMessage, type GateAnswer, type GitStatus, type HubProject, type MapProgress, type PlanAnswer, type ReviewGraphFile, type SettingsView } from '@ide/protocol';
import { createPortal } from 'react-dom';
import { BranchChip } from '../git/BranchChip';
import { GitClient } from '../git/git-client';
import { changedCount } from '../git/git-state';
import { GitDiffView } from '../git/GitDiffView';
import { GitPanel, type GitSelection } from '../git/GitPanel';
import { ErrorBoundary } from '../layout/ErrorBoundary';
import { ChatPanel, type AgentView } from '../chat/ChatPanel';
import { canSend, chatReducer, initialChatState, toolSummary } from '../chat/chat-state';
import { ImageStore } from '../chat/image-store';
import { dialogEvent, eventFilePaths } from '../history/dialog-state';
import { changeIndex, latestPlanVersion, historyReducer, initialHistoryState, type TimelineItem } from '../history/history-state';
import { WatchdogDialog } from '../history/WatchdogDialog';
import { DiffPanel } from '../history/DiffPanel';
import { projectPathOf } from '../history/project-path';
import { ReviewMode } from '../history/ReviewMode';
import { ReviewPanel } from '../history/ReviewPanel';
import { reviewSections, sectionFiles } from '../history/review-model';
import { followUpFiles } from '../history/review-state';
import { Timeline } from '../history/Timeline';
import { DetailsPanel, type DetailsTab } from '../map/DetailsPanel';
import { initialMapState, mapReducer } from '../map/map-state';
import { MapView } from '../map/MapView';
import { MapActivity } from '../map/MapActivity';
import { ViewSwitch } from '../map/ViewSwitch';
import { PlanOverlayContext, type PlanOverlay } from '../plan/overlay';
import { PlanPanel } from '../plan/PlanPanel';
import { PlanDock } from '../plan/PlanDock';
import { chimeKey, finishedWorking, playChime, playDone, type Activity } from '../plan/chime';
import { initialPlanState, pendingPrompts, planMarks, planOnMap, planReducer, waitsForUser } from '../plan/plan-state';
import { C4View } from '../c4/C4View';
import { OverviewPending, OverviewView } from '../overview/OverviewView';
import { PlanFlowView } from '../plan-flow/PlanFlowView';
import { flowOf } from '../plan-flow/flow-model';
import { availableModes, resolveMode, type MapMode } from '../plan-flow/map-mode';
import { describeMapStatus, describeProgress } from '../map/status';
import { connect, fitsFrame, type Connection, type ConnectionStatus } from '../net/socket';
import { SettingsPanel, type SettingsResult } from '../settings/SettingsPanel';
import { Icon } from '../layout/Icon';
import { DetailsSlotContext } from '../layout/DetailsSlot';
import { LeftPanel } from '../layout/LeftPanel';
import { RightPanel } from '../layout/RightPanel';
import { loadPanels, panelReducer, savePanels } from '../layout/panel-state';
import { Resizer } from '../layout/Resizer';
import { ComponentTree, FileTree } from '../layout/Trees';
import { clampSize, DEFAULT_SIZES, LIMITS, loadSizes, saveSizes, type PanelSizes, type SizedPanel } from '../layout/sizes';
import { storage, typing } from '../layout/dom';
import { TerminalPanel } from '../terminal/TerminalPanel';
import { AgentTerminal } from '../terminal/AgentTerminal';
import { TerminalHub, type TerminalTab } from '../terminal/terminal-hub';
import type { ChatList } from '../chat/ChatSwitcher';
import { deriveStatus, type ProjectStatus } from './project-status';

export interface ProjectViewProps {
  project: HubProject;
  token: string;
  // Where the project core listens; the page's own address when it is the core serving this page.
  url?: string;
  active: boolean;
  // Bumped by the top bar's gear; only the shown project reacts.
  settingsRequest: number;
  onStatus: (id: string, status: ProjectStatus) => void;
  onBadge: (id: string, count: number) => void;
  // The top bar's empty slot for the branch chip; only the shown project renders into it.
  branchSlot: HTMLElement | null;
}

export function ProjectView({ project, token, url, active, settingsRequest, onStatus, onBadge, branchSlot }: ProjectViewProps) {
  const [state, dispatch] = useReducer(mapReducer, initialMapState);
  const [chat, dispatchChat] = useReducer(chatReducer, initialChatState);
  const stoppedByUser = useRef(false);
  const [plans, dispatchPlans] = useReducer(planReducer, initialPlanState);
  const [hist, dispatchHist] = useReducer(historyReducer, initialHistoryState);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [settingsResult, setSettingsResult] = useState<SettingsResult | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const [progress, setProgress] = useState<MapProgress>({ indexing: null, embedding: null });
  const link = useRef<Connection | null>(null);
  const [focus, setFocus] = useState<{ componentIds: string[]; nonce: number } | null>(null);
  const [anchored, setAnchored] = useState(false);
  const [tab, setTab] = useState<DetailsTab>('details');
  const [highlight, setHighlight] = useState<Set<string>>(new Set());
  const [panels, dispatchPanels] = useReducer(panelReducer, project.id, (id) => loadPanels(storage(), id));
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([]);
  const [terminalsKnown, setTerminalsKnown] = useState(false);
  const [agentOpening, setAgentOpening] = useState(false);
  const sendRef = useRef<(message: ClientMessage) => boolean>(() => false);
  const hub = useMemo(() => new TerminalHub((message) => sendRef.current(message), setTerminalTabs), []);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitSelection, setGitSelection] = useState<GitSelection | null>(null);
  const git = useMemo(() => new GitClient((message) => sendRef.current(message)), []);
  const images = useMemo(() => new ImageStore((message) => sendRef.current(message)), []);
  useEffect(() => () => images.dispose(), [images]);
  const [sizes, setSizes] = useState<PanelSizes>(() => loadSizes(storage()));
  const [chats, setChats] = useState<ChatList>({ activeId: null, sessions: [], models: [], engines: [] });
  const [reviewMode, setReviewMode] = useState(false);
  const [chatFocus, setChatFocus] = useState<{ id: string; nonce: number } | null>(null);
  const [detailsEl, setDetailsEl] = useState<HTMLElement | null>(null);
  const snapshot = state.snapshot;
  const shown = useMemo(() => planOnMap(plans.plans), [plans.plans]);
  const marks = useMemo(() => planMarks(shown, snapshot), [shown, snapshot]);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
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
          dispatchHist({ type: 'result', requestId: message.requestId, error: message.error, diff: message.diff, preview: message.preview, graph: message.graph });
          break;
        case 'git.snapshot':
          setGitStatus(message.status);
          break;
        case 'git.result':
          git.handle(message);
          break;
        case 'terminal.snapshot':
          hub.restore(message.terminals);
          setTerminalsKnown(true);
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
          setChats((previous) => ({ ...previous, activeId: message.activeId, sessions: message.sessions, next: message.next }));
          break;
        case 'models.snapshot':
          setChats((previous) => ({ ...previous, models: message.models }));
          break;
        case 'engines.snapshot':
          setChats((previous) => ({ ...previous, engines: message.engines }));
          break;
        case 'image.data':
        case 'image.failed':
          images.handle(message);
          break;
        case 'error':
          dispatchChat({ type: 'error', message: message.message });
          break;
      }
    }, (next) => {
      setConnection(next);
      if (next !== 'open') setTerminalsKnown(false);
      if (next !== 'open') git.dropAll();
      images.setOnline(next === 'open');
      if (next === 'open') link.current?.send({ type: 'models.list' });
    }, url);
    link.current = current;
    return () => current.close();
  }, [token, url, hub, git, images]);

  const send = (message: ClientMessage): boolean => {
    if (!fitsFrame(message)) {
      dispatchChat({ type: 'error', message: 'This message is too long to send: the limit is 64 KiB.' });
      return false;
    }
    if (!link.current?.send(message)) {
      dispatchChat({ type: 'error', message: 'Not connected to the CodeRay core.' });
      return false;
    }
    if (message.type === 'chat.stop') stoppedByUser.current = true;
    return true;
  };

  sendRef.current = (message) => link.current?.send(message) ?? false;

  const openSettings = (): void => {
    send({ type: 'settings.get' });
    setSettingsOpen(true);
  };
  const openSettingsRef = useRef(openSettings);
  openSettingsRef.current = openSettings;
  const lastSettingsRequest = useRef(settingsRequest);
  useEffect(() => {
    if (settingsRequest === lastSettingsRequest.current) return;
    lastSettingsRequest.current = settingsRequest;
    if (activeRef.current) openSettingsRef.current();
  }, [settingsRequest]);
  const toReview = (settings?.servers.filter((server) => server.status === 'unapproved').length ?? 0)
    + (settings?.externalEdits.ideServers || settings?.externalEdits.trust ? 1 : 0)
    + (settings?.policy.externalEdits.ide || settings?.policy.externalEdits.project ? 1 : 0);
  useEffect(() => {
    onBadge(project.id, toReview);
  }, [onBadge, project.id, toReview]);

  useEffect(() => {
    savePanels(storage(), panels, project.id);
  }, [panels, project.id]);
  useEffect(() => {
    saveSizes(storage(), sizes);
  }, [sizes]);
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
      if (!activeRef.current) return;
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        openSettingsRef.current();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && (event.code === 'KeyB' || event.key.toLowerCase() === 'b') && !event.shiftKey) {
        event.preventDefault();
        dispatchPanels({ type: 'toggle', panel: event.altKey ? 'right' : 'left' });
        return;
      }
      if (event.ctrlKey && event.key === '`') {
        event.preventDefault();
        toggleTerminalRef.current();
        return;
      }
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyG') {
        event.preventDefault();
        dispatchPanels({ type: 'left-tab', tab: 'git' });
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
    if (waitingPlan && activeRef.current) playChime();
  }, [waitingPlan]);
  const activity: Activity = { chatId: chat.session?.id ?? null, busy: !canSend(chat) };
  const lastActivity = useRef<Activity | null>(null);
  useEffect(() => {
    if (finishedWorking(lastActivity.current, activity, stoppedByUser.current) && activeRef.current) playDone();
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
  const projectStatus = useMemo(
    () => deriveStatus({ connection, chat, plan: shown, prompts: plans.prompts, watchdog: watchdog !== null }),
    [connection, chat, shown, plans.prompts, watchdog],
  );
  useEffect(() => {
    onStatus(project.id, projectStatus);
  }, [onStatus, project.id, projectStatus.kind, projectStatus.line]);
  const requestDiff = (path: string, before: string | null, after: string | null): string | null => {
    const requestId = crypto.randomUUID();
    return send({ type: 'history.diff', requestId, path, before, after }) ? requestId : null;
  };
  const requestGraph = (files: ReviewGraphFile[], planId: string | null): string | null => {
    const requestId = crypto.randomUUID();
    return send({ type: 'review.graph', requestId, planId, files }) ? requestId : null;
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
  const flowPlan = flowOf(shown) === null ? null : shown;
  const modeInput = { hasC4: c4 !== null, hasFlow: flowPlan !== null, hasOverview: snapshot?.overview !== undefined };
  const [preferredMode, setPreferredMode] = useState<MapMode | null>(null);
  const modes = availableModes(modeInput);
  const mode = resolveMode(preferredMode, modeInput);
  const showC4 = snapshot !== null && c4 !== null && mode === 'c4';
  const [hoverStep, setHoverStep] = useState<string | null>(null);
  const waitingFlowKey = shown !== null && shown.status === 'proposed' && shown.flow !== null ? `${shown.id}@${shown.version}` : null;
  useEffect(() => {
    if (waitingFlowKey !== null) setPreferredMode('flow');
  }, [waitingFlowKey]);
  useEffect(() => {
    setHoverStep(null);
  }, [planKey]);
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
  const showPathsOnMap = (paths: string[]): void => {
    const toProject = projectPathOf(snapshot);
    const wanted = new Set(paths.map(toProject));
    const owners = new Set(snapshot?.files.filter((file) => wanted.has(file.path)).flatMap((file) => (file.componentId ? [file.componentId] : [])));
    if (owners.size > 0) focusComponents([...owners]);
  };
  const followUps = useMemo(() => (shown ? followUpFiles(hist.history, plans.plans, shown.id) : []), [hist.history, plans.plans, shown]);
  const reviewFiles = useMemo(() => sectionFiles(reviewSections(hist.history, plans.plans)).length, [hist.history, plans.plans]);
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
          commandOf={(id) => toolSummary(chat, id)}
        />
      )}
    />
  );
  const showRight = panels.right;
  const agentTab = terminalTabs.find((tab) => tab.kind === 'agent') ?? null;
  const shellTabs = useMemo(() => terminalTabs.filter((tab) => tab.kind !== 'agent'), [terminalTabs]);
  const agentView: AgentView = agentTab !== null || agentOpening ? 'terminal' : 'chat';
  const changeAgentView = (view: AgentView): void => {
    if (view === agentView) return;
    if (view === 'terminal') {
      dispatchChat({ type: 'dismiss-error' });
      setAgentOpening(hub.createAgent());
      return;
    }
    // A terminal still starting has no tab yet; closing it cancels the start.
    if (agentTab || agentOpening) hub.close(AGENT_TERMINAL_ID);
    setAgentOpening(false);
  };
  useEffect(() => {
    if (agentTab !== null || chat.error !== null || chat.session?.status === 'refused') setAgentOpening(false);
  }, [agentTab, chat.error, chat.session?.status]);
  const toggle = (panel: 'left' | 'right', label: string, keys: string) => (
    <button className={`status-toggle${panels[panel] ? ' on' : ''}`} onClick={() => dispatchPanels({ type: 'toggle', panel })} aria-pressed={panels[panel]} aria-label={label} data-tip={label} data-keys={keys}>
      <Icon name={panel === 'left' ? 'panel-left' : 'panel-right'} size={16} />
    </button>
  );
  return (
    <DetailsSlotContext.Provider value={detailsSlot}>
      <div className={`project-view${active ? '' : ' away'}${panels.focus ? ' focus' : ''}`} inert={!active} style={{ '--left-w': `${sizes.left}px`, '--right-w': `${sizes.right}px`, '--bottom-h': `${sizes.bottom}px` } as React.CSSProperties}>
        <div className="workspace">
          <LeftPanel
            hidden={!panels.left || reviewMode}
            tab={panels.leftTab}
            onTab={(next) => dispatchPanels({ type: 'left-tab', tab: next })}
            components={snapshot ? <ComponentTree snapshot={snapshot} changes={changes} marks={marks} selected={state.selected} onSelectComponent={selectComponent} onSelectFile={selectFile} /> : <div className="empty muted">Waiting for the map…</div>}
            gitCount={changedCount(gitStatus)}
            git={<GitPanel status={gitStatus} client={git} selection={gitSelection} onSelect={setGitSelection} />}
            detailsRef={setDetailsEl}
            files={snapshot ? <FileTree snapshot={snapshot} changes={changes} selected={state.selected} onSelectFile={selectFile} /> : <div className="empty muted">Waiting for the map…</div>}
          />
          {panels.left && !reviewMode && <Resizer orientation="vertical" label="Resize project panel" value={sizes.left} min={LIMITS.left.min} max={LIMITS.left.max} grow={1} onResize={(size) => resize('left', size)} onReset={() => resetSize('left')} />}
          <main className={`map-area${modes.length > 1 ? ' has-view' : ''}`}>
            <MapActivity progress={progress} status={snapshot?.status ?? null} />
            {modes.length > 1 && <ViewSwitch modes={modes} mode={mode} onMode={setPreferredMode} />}
            <div className="map-regroup">
              <button type="button" onClick={() => send({ type: 'map.regroup' })}>Regroup</button>
            </div>
            <PlanOverlayContext.Provider value={overlay}>
              {mode === 'overview' && snapshot ? (
                <ReactFlowProvider>
                  {snapshot.overview && snapshot.overview.groups.length > 0 ? (
                    <OverviewView snapshot={snapshot} overview={snapshot.overview} onRebuild={() => send({ type: 'map.overview' })} />
                  ) : (
                    <OverviewPending overview={snapshot.overview} onRebuild={() => send({ type: 'map.overview' })} />
                  )}
                </ReactFlowProvider>
              ) : showC4 && snapshot && c4 ? (
                <ReactFlowProvider>
                  <C4View snapshot={snapshot} model={c4} />
                </ReactFlowProvider>
              ) : mode === 'flow' && flowPlan?.flow ? (
                <ReactFlowProvider>
                  <PlanFlowView plan={flowPlan} flow={flowPlan.flow} hoverStep={hoverStep} onAnswer={answerPlan} keys={active && !reviewMode} working={activity.busy} />
                </ReactFlowProvider>
              ) : (
                <ReactFlowProvider>
                  <MapView state={state} dispatch={dispatch} />
                </ReactFlowProvider>
              )}
              {mode === 'components' && mapDetails}
            </PlanOverlayContext.Provider>
            {reviewMode && (
              <ReviewMode
                history={hist.history}
                plans={plans.plans}
                results={hist.results}
                chatItems={chat.items}
                requestDiff={requestDiff}
                requestGraph={requestGraph}
                forgetResult={(requestId) => dispatchHist({ type: 'forget', requestId })}
                send={send}
                root={project.root}
                onOpenChat={() => {
                  dispatchPanels({ type: 'right-tab', tab: 'agent' });
                  dispatchChat({ type: 'filter', filter: null });
                }}
                onShowInChat={(id) => {
                  dispatchPanels({ type: 'right-tab', tab: 'agent' });
                  dispatchChat({ type: 'filter', filter: null });
                  setChatFocus({ id, nonce: Date.now() });
                }}
                onShowOnMap={(paths) => {
                  setReviewMode(false);
                  showPathsOnMap(paths);
                }}
                onExit={() => setReviewMode(false)}
                active={active}
              />
            )}
            {gitSelection && gitStatus && <GitDiffView selection={gitSelection} status={gitStatus} client={git} onClose={() => setGitSelection(null)} />}
          </main>
          {showRight && <Resizer orientation="vertical" label="Resize agent panel" value={sizes.right} min={LIMITS.right.min} max={LIMITS.right.max} grow={-1} onResize={(size) => resize('right', size)} onReset={() => resetSize('right')} />}
          <RightPanel
            hidden={!showRight}
            tab={panels.rightTab}
            onTab={(next) => dispatchPanels({ type: 'right-tab', tab: next })}
            hasPlan={shown !== null}
            reviewCount={reviewFiles}
            agent={(
              <ErrorBoundary label="The chat">
                <ChatPanel
                  chat={chat}
                  chats={chats}
                  send={send}
                  focusItem={chatFocus}
                  onClearFilter={() => dispatchChat({ type: 'filter', filter: null })}
                  onDismissError={() => dispatchChat({ type: 'dismiss-error' })}
                  prompts={pendingPrompts(plans.prompts)}
                  dialog={watchdog && <WatchdogDialog key={watchdog.id} event={watchdog} diffs={hist.results} send={send} requestDiff={requestDiff} />}
                  planDock={shown && waitsForUser(shown) && (
                    <PlanDock key={planKey} plan={shown} snapshot={snapshot} working={activity.busy} onAnswer={answerPlan} onFocusStep={(index) => focusComponents(marks.stepComponents[index] ?? [])} onHoverStep={setHoverStep} />
                  )}
                  promptAnchored={anchored}
                  onAnswerPrompt={(promptId, answer) => send({ type: 'gate.answer', promptId, answer })}
                  onFocusTargets={showPathsOnMap}
                  view={agentView}
                  onView={changeAgentView}
                  images={images}
                  imagesLive={active && showRight && panels.rightTab === 'agent'}
                  terminal={(
                    <AgentTerminal
                      hub={hub}
                      tab={agentTab}
                      visible={active && showRight && panels.rightTab === 'agent'}
                      onRestart={() => {
                        if (agentTab) hub.close(agentTab.id);
                        dispatchChat({ type: 'dismiss-error' });
                        setAgentOpening(hub.createAgent());
                      }}
                      onBack={() => changeAgentView('chat')}
                    />
                  )}
                />
              </ErrorBoundary>
            )}
            plan={shown && !waitsForUser(shown) ? (
              <PlanPanel
                key={planKey}
                plan={shown}
                snapshot={snapshot}
                open
                working={activity.busy}
                followUps={followUps}
                onAnswer={answerPlan}
                onFocusStep={(index) => focusComponents(marks.stepComponents[index] ?? [])}
                onHoverStep={setHoverStep}
                onShowFiles={showPathsOnMap}
              />
            ) : (
              <div className="empty muted">{shown ? 'The plan is waiting for your answer above the chat.' : 'No plan yet. When the agent proposes one, it appears above the chat and on the map.'}</div>
            )}
            review={(
              <ReviewPanel history={hist.history} plans={plans.plans} diffs={hist.results} requestDiff={requestDiff} onShowOnMap={showPathsOnMap} onStart={() => {
                setReviewMode(true);
                dispatchPanels({ type: 'right-tab', tab: 'agent' });
              }} />
            )}
          />
        </div>
        <div className="bottom-area">
          {panels.bottom && !panels.focus && <Resizer orientation="horizontal" label="Resize timeline" value={sizes.bottom} min={LIMITS.bottom.min} max={LIMITS.bottom.max} grow={-1} onResize={(size) => resize('bottom', size)} onReset={() => resetSize('bottom')} />}
          <Timeline
            plans={plans.plans}
            latestPlan={latestPlan}
            history={hist.history}
            results={hist.results}
            chat={chat}
            send={send}
            onSelect={selectTimelineItem}
            open={panels.bottom && !panels.focus}
            onToggle={() => dispatchPanels({ type: 'toggle', panel: 'bottom' })}
            tab={panels.bottomTab}
            onTab={(next) => dispatchPanels({ type: 'bottom-tab', tab: next })}
            terminalCount={shellTabs.length}
            compact={panels.focus}
            leading={(
              <>
                {toggle('left', 'Project panel', '⌘ B')}
                <span className="status-gap" />
              </>
            )}
            trailing={(
              <>
                <span className={`conn ${connection}`}><i className="dot" />{connection === 'open' ? 'core connected' : connection}</span>
                {mapChips.map((chip) => (
                  <span key={chip.text} className={`chip ${chip.tone}`} title={chip.title}>{chip.text}</span>
                ))}
                <span className="status-gap" />
                {toggle('right', 'Agent and details', '⌘ ⌥ B')}
                <button className={`status-toggle${panels.focus ? ' on' : ''}`} onClick={() => dispatchPanels({ type: 'focus' })} aria-pressed={panels.focus} aria-label="Focus: map only" data-tip="Focus: map only" data-keys="F">
                  <Icon name="maximize" size={16} />
                </button>
              </>
            )}
            terminal={<TerminalPanel hub={hub} tabs={shellTabs} known={terminalsKnown} visible={active && panels.bottom && panels.bottomTab === 'terminal' && !panels.focus} />}
          />
        </div>
        {settingsOpen && (
          <SettingsPanel
            settings={settings}
            lastResult={settingsResult}
            sessionServers={chat.mcpServers}
            send={send}
            onClose={() => setSettingsOpen(false)}
            projectName={snapshot?.projectName ?? project.name}
          />
        )}
      </div>
      {active && branchSlot ? createPortal(<BranchChip status={gitStatus} client={git} />, branchSlot) : null}
    </DetailsSlotContext.Provider>
  );
}
