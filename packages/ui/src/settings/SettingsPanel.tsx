import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ClientMessage, EngineId, McpServerState, PolicyLevel, SettingsView } from '@ide/protocol';
import { Icon } from '../layout/Icon';
import { ACCOUNT_BLOCKS, engineAccounts, type ProviderList } from './accounts';
import { AccountsSection } from './AccountsSection';
import { APPEARANCE_BLOCKS, AppearanceBlock } from './AppearanceBlocks';
import { applyAppearance, loadAppearance, saveAppearance, systemReducesMotion, type Appearance } from './appearance';
import { ClaudeCodeServersBlock, McpServersBlock, claudeRows } from './McpBlocks';
import {
  BLOCKS, CATEGORIES, blocksOf, categoryOf, countByCategory, matchBlocks, type BlockId, type CategoryId,
} from './categories';
import { Banner, Kbd, Setting } from './controls';
import { POLICY_BLOCKS, PolicyBlock } from './PolicyBlocks';
import { ScopeSwitch } from './PolicyControls';
import { usePolicyDrafts } from './policy-drafts';
import { policyFromForm } from './policy-form';
import { useRequests, useToasts, type SettingsResult } from './requests';
import { SaveBar, Toasts } from './SaveBar';
import { loadCategory, loadScope, localStorageOrUndefined, saveCategory, saveScope } from './storage';
import './settings.css';

export type { SettingsResult } from './requests';

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
  preventDefault: () => void;
  stopPropagation: () => void;
}

const noun = (engine: EngineId): string => (engine === 'opencode' ? 'Profile' : 'Account');

const typing = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  return element !== null && (/^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) || element.isContentEditable);
};

export function SettingsPanel({ settings, lastResult, providers, loadProviders, sessionServers, send, onClose, initialCategory, projectName }: {
  settings: SettingsView | null;
  lastResult: SettingsResult | null;
  /** The opencode profiles' providers, by profile id, as `settings.providers` gave them. */
  providers: Record<string, ProviderList>;
  /** Asks the core for a profile's providers, outside the one-at-a-time requests: the answer is a `settings.providers`, never a `settings.result`. */
  loadProviders: (id: string) => void;
  sessionServers: McpServerState[];
  send: (message: ClientMessage) => boolean;
  onClose: () => void;
  initialCategory?: CategoryId;
  projectName?: string;
}) {
  const storage = useMemo(localStorageOrUndefined, []);
  const [category, setCategory] = useState<CategoryId>(() => initialCategory ?? loadCategory(storage));
  const [scope, setScope] = useState<PolicyLevel>(() => loadScope(storage));
  const [query, setQuery] = useState('');
  const [closing, setClosing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [restartPending, setRestartPending] = useState(false);
  const [appearance, setAppearance] = useState<Appearance>(() => loadAppearance(storage));
  const [attempt, setAttempt] = useState(0);
  const [slow, setSlow] = useState(false);
  const [openProfile, setOpenProfile] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);
  const { toasts, notify, dismiss } = useToasts();
  const { busy, run } = useRequests(send, lastResult, notify);
  const drafts = usePolicyDrafts(settings?.policy ?? null);
  const changes = drafts?.changes ?? [];

  useEffect(() => {
    opener.current = document.activeElement;
    root.current?.querySelector<HTMLElement>('.sw-tab.on')?.focus();
    return () => (opener.current as HTMLElement | null)?.focus?.();
  }, []);
  useEffect(() => {
    if (settings) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(timer);
  }, [settings, attempt]);
  useEffect(() => saveCategory(storage, category), [storage, category]);
  useEffect(() => saveScope(storage, scope), [storage, scope]);
  useEffect(() => {
    if (changes.length === 0) setClosing(false);
  }, [changes.length]);

  const choose = (id: CategoryId): void => {
    setCategory(id);
    setQuery('');
  };

  const requestClose = (): void => (changes.length > 0 ? setClosing(true) : onClose());

  const saveAll = useCallback((): void => {
    if (!drafts || saving) return;
    const levels = drafts.dirtyLevels;
    const payloads = levels.map((level) => ({ level, result: policyFromForm(drafts.forms[level]) }));
    const invalid = payloads.find((entry) => 'error' in entry.result);
    if (invalid && 'error' in invalid.result) {
      setSaveError(invalid.result.error);
      return;
    }
    setSaveError(null);
    setSaving(true);
    const queue = payloads.flatMap((entry) => ('policy' in entry.result ? [{ level: entry.level, policy: entry.result.policy }] : []));
    const step = (index: number): void => {
      const item = queue[index];
      if (!item) {
        setSaving(false);
        notify('ok', 'Settings saved');
        return;
      }
      const sent = run(
        { type: 'policy.save', requestId: crypto.randomUUID(), level: item.level, policy: item.policy },
        { onSettled: (error) => (error === null ? step(index + 1) : setSaving(false)) },
      );
      if (!sent) setSaving(false);
    };
    step(0);
  }, [drafts, saving, run, notify]);

  const policyError = useMemo(() => {
    if (!drafts) return null;
    for (const level of drafts.dirtyLevels) {
      const result = policyFromForm(drafts.forms[level]);
      if ('error' in result) return result.error;
    }
    return saveError;
  }, [drafts, saveError]);

  const policyView = settings?.policy ?? null;
  const edits = settings?.externalEdits;
  const unapproved = settings?.servers.filter((server) => server.status === 'unapproved').length ?? 0;
  const attention: Record<CategoryId, number> = {
    agent: policyView && (policyView.externalEdits.ide || policyView.externalEdits.project) ? 1 : 0,
    paths: 0,
    mcp: unapproved + (edits && (edits.ideServers || edits.trust) ? 1 : 0),
    accounts: 0,
    appearance: 0,
  };

  const searching = query.trim() !== '';
  const hasClaudeRows = settings !== null && claudeRows(settings, sessionServers).length > 0;
  const engineLists = settings ? engineAccounts(settings.accounts) : [];
  const listOf = (id: BlockId) => engineLists.find((list) => list.engine === ACCOUNT_BLOCKS[id]);
  // A block shows when it has something to show: Claude Code's servers when there are any, an engine's accounts when the core runs it.
  const shown = (id: BlockId): boolean => (id === 'claude-code-servers' ? hasClaudeRows : ACCOUNT_BLOCKS[id] === undefined || listOf(id) !== undefined);
  const matched = useMemo(() => matchBlocks(query, {
    'mcp-servers': (settings?.servers ?? []).map((server) => server.name),
    'claude-code-servers': (settings?.claudeCodeServers ?? []).map((server) => server.name),
    accounts: (listOf('accounts')?.accounts ?? []).map((account) => account.email),
    'accounts-codex': (listOf('accounts-codex')?.accounts ?? []).map((account) => account.email),
    'accounts-opencode': (listOf('accounts-opencode')?.accounts ?? []).map((account) => account.email),
  }).filter((block) => shown(block.id)), [query, settings, hasClaudeRows]);
  const counts = countByCategory(matched);
  const visible: BlockId[] = searching ? matched.map((block) => block.id) : blocksOf(category).map((block) => block.id).filter(shown);
  const showsPolicy = visible.some((id) => POLICY_BLOCKS.includes(id));
  const page = categoryOf(category);

  const changeAppearance = (next: Appearance): void => {
    setAppearance(next);
    saveAppearance(storage, next);
    applyAppearance(document.documentElement, next);
  };

  const renderBlock = (id: BlockId): ReactNode => {
    if (POLICY_BLOCKS.includes(id)) {
      if (!policyView || !drafts) return null;
      return <PolicyBlock key={id} id={id} view={policyView} drafts={drafts} scope={scope} onScope={setScope} />;
    }
    if (ACCOUNT_BLOCKS[id] !== undefined) {
      const block = BLOCKS.find((candidate) => candidate.id === id)!;
      const list = listOf(id);
      return (
        <Setting key={id} id={id} title={block.title} help={block.help}>
          {settings && list && (
            <AccountsSection
              engine={list.engine}
              view={list}
              login={settings.accounts.login}
              busy={busy}
              onRequest={(message, options) => run(message, { okText: message.type === 'account.select' ? `${noun(list.engine)} switched` : message.type === 'account.remove' ? `${noun(list.engine)} removed` : undefined, ...options })}
              providers={providers}
              open={openProfile}
              onProviders={(id) => {
                setOpenProfile(id);
                if (id !== null) loadProviders(id);
              }}
            />
          )}
        </Setting>
      );
    }
    if (id === 'mcp-servers' || id === 'claude-code-servers') {
      const block = BLOCKS.find((candidate) => candidate.id === id)!;
      if (!settings) return null;
      return (
        <Setting key={id} id={id} title={block.title} help={block.help}>
          {id === 'mcp-servers' ? (
            <McpServersBlock
              settings={settings}
              sessionServers={sessionServers}
              busy={busy}
              run={run}
              restartPending={restartPending}
              onChanged={() => setRestartPending(true)}
              onRestart={() => { send({ type: 'session.restart' }); setRestartPending(false); notify('ok', 'Session restarting'); }}
            />
          ) : <ClaudeCodeServersBlock settings={settings} sessionServers={sessionServers} />}
        </Setting>
      );
    }
    if (APPEARANCE_BLOCKS.includes(id)) {
      return <AppearanceBlock key={id} id={id} value={appearance} systemReducesMotion={systemReducesMotion()} onChange={changeAppearance} />;
    }
    return null;
  };

  const renderBlocks = (ids: BlockId[]): ReactNode =>
    ids.length > 0 && ids.every((id) => APPEARANCE_BLOCKS.includes(id)) ? <div className="sw-group">{ids.map(renderBlock)}</div> : ids.map(renderBlock);

  const policyBanners = policyView && (policyView.externalEdits.ide || policyView.externalEdits.project) ? (
    <Banner
      tone="warn"
      title="A policy file changed outside Settings"
      actions={<button type="button" className="sw-btn" disabled={busy} onClick={() => run({ type: 'policy.confirm-external-edits', requestId: crypto.randomUUID(), hashes: policyView.hashes }, { okText: 'Policy edits confirmed' })}>Confirm the edits</button>}
    >
      It is ignored until you confirm it: the all-projects level falls back to the defaults, this project to the all-projects level. The file now says:
      {policyView.edited.ide !== null && <pre>All projects: {policyView.edited.ide}</pre>}
      {policyView.edited.project !== null && <pre>This project: {policyView.edited.project}</pre>}
    </Banner>
  ) : null;

  const handleKey = (event: KeyEventLike): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (closing) setClosing(false);
      else if (searching) {
        setQuery('');
        search.current?.blur();
      } else requestClose();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (changes.length > 0 && policyError === null) saveAll();
      return;
    }
    if (event.key === '/' && !typing(event.target) && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      search.current?.focus();
      return;
    }
    if (event.key === 'Tab' && root.current) {
      const items = [...root.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (!root.current.contains(document.activeElement)) {
        event.preventDefault();
        first?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    event.stopPropagation();
  };

  const latestKey = useRef(handleKey);
  latestKey.current = handleKey;
  useEffect(() => {
    // Focus falls to <body> when the focused control unmounts; the shortcuts must still work then.
    const onDocumentKey = (event: globalThis.KeyboardEvent): void => {
      if (!event.defaultPrevented && !root.current?.contains(event.target as Node)) latestKey.current(event);
    };
    document.addEventListener('keydown', onDocumentKey);
    return () => document.removeEventListener('keydown', onDocumentKey);
  }, []);

  const onRailKey = (event: KeyboardEvent<HTMLElement>): void => {
    const index = CATEGORIES.findIndex((item) => item.id === category);
    const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? CATEGORIES.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const target = CATEGORIES[(next + CATEGORIES.length) % CATEGORIES.length]!;
    choose(target.id);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`#sw-tab-${target.id}`)?.focus());
  };

  const loading = settings === null;
  const title = searching ? 'Search' : page.label;
  const intro = searching
    ? matched.length === 0 ? 'No setting matches.' : `${matched.length} ${matched.length === 1 ? 'setting matches' : 'settings match'} “${query.trim()}”.`
    : page.intro;

  return (
    <div className="sw-backdrop" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
      <div ref={root} className="sw" role="dialog" aria-modal="true" aria-label="Settings" tabIndex={-1} onKeyDown={handleKey}>
        <nav className="sw-rail" aria-label="Settings categories">
          <div className="sw-rail-title"><b>Settings</b>{projectName && <span title={projectName}>{projectName}</span>}</div>
          <div className="sw-tabs" role="tablist" aria-orientation="vertical" onKeyDown={onRailKey}>
            {CATEGORIES.map((item) => {
              const on = !searching && item.id === category;
              const count = searching ? counts[item.id] : attention[item.id];
              return (
                <button
                  key={item.id}
                  id={`sw-tab-${item.id}`}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  aria-controls="sw-page"
                  tabIndex={item.id === category ? 0 : -1}
                  title={item.label}
                  className={`sw-tab${on ? ' on' : ''}${searching && counts[item.id] === 0 ? ' dim' : ''}`}
                  onClick={() => choose(item.id)}
                >
                  <Icon name={item.icon} size={16} />
                  <span className="sw-tab-label">{item.label}</span>
                  {count > 0 && <span className={`sw-tab-count${searching ? '' : ' warn'}`} aria-label={searching ? `${count} ${count === 1 ? 'match' : 'matches'}` : `${count} to review`}>{count}</span>}
                </button>
              );
            })}
          </div>
          <div className="sw-rail-foot">
            <span><Kbd>⌘</Kbd><Kbd>,</Kbd> open anywhere</span>
            <span><Kbd>/</Kbd> search</span>
            <span><Kbd>esc</Kbd> close</span>
            <a className="sw-sponsor" href="https://www.patreon.com/c/shestakoven" target="_blank" rel="noopener noreferrer">Support CodeRay</a>
          </div>
        </nav>
        <main className="sw-main" id="sw-page" role="tabpanel" aria-labelledby={`sw-tab-${category}`}>
          <header className="sw-head">
            <div className="sw-title">
              <h2>{title}</h2>
              <p>{intro}</p>
            </div>
            <label className="sw-search">
              <Icon name="search" size={14} />
              <input
                ref={search}
                value={query}
                placeholder="Search settings"
                aria-label="Search settings"
                onChange={(event) => setQuery(event.target.value)}
              />
              {searching ? (
                <button type="button" className="sw-clear" aria-label="Clear search" onClick={() => { setQuery(''); search.current?.focus(); }}><Icon name="close" size={12} /></button>
              ) : <Kbd>/</Kbd>}
            </label>
            <button type="button" className="sw-close" aria-label="Close settings" title="Close (Esc)" onClick={requestClose}><Icon name="close" size={16} /></button>
          </header>
          {showsPolicy && (
            <div className="sw-scope-row">
              <ScopeSwitch scope={scope} onChange={setScope} />
              <span className="sw-scope-note">
                {scope === 'project' ? `Values for ${projectName ?? 'this project'}. Anything you leave alone follows All projects.` : 'The defaults every project starts from. A project can override them.'}
              </span>
            </div>
          )}
          <div className="sw-scroll">
            {loading ? (
              <div className="sw-page">
                {slow && (
                  <Banner
                    tone="error"
                    title="Settings did not load"
                    actions={<button type="button" className="sw-btn" onClick={() => { send({ type: 'settings.get' }); setSlow(false); setAttempt(attempt + 1); }}>Try again</button>}
                  >
                    The core has not answered yet. Check that it is running, then try again.
                  </Banner>
                )}
                <div className="sw-skeleton" aria-busy="true"><i /><i className="block" /><i className="block" /></div>
              </div>
            ) : searching && matched.length === 0 ? (
              <div className="sw-page">
                <p className="sw-empty">Nothing matches “{query.trim()}”. Try a shorter word, or <button type="button" className="sw-link" onClick={() => setQuery('')}>clear the search</button>.</p>
              </div>
            ) : (
              <div className="sw-page">
                {showsPolicy && policyBanners}
                {searching
                  ? CATEGORIES.filter((item) => counts[item.id] > 0).map((item) => (
                      <div key={item.id} className="sw-results-group">
                        <h3 className="sw-results-title"><Icon name={item.icon} size={14} /> {item.label}</h3>
                        {renderBlocks(matched.filter((block) => block.category === item.id).map((block) => block.id))}
                      </div>
                    ))
                  : renderBlocks(visible)}
              </div>
            )}
          </div>
          <div className="sw-dock">
            <Toasts toasts={toasts} onDismiss={dismiss} />
            {changes.length > 0 && (
              <SaveBar
                changes={changes}
                saving={saving}
                error={policyError}
                closing={closing}
                onSave={saveAll}
                onDiscard={() => { drafts?.discard(); setSaveError(null); }}
                onKeepEditing={() => setClosing(false)}
                onDiscardAndClose={onClose}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
