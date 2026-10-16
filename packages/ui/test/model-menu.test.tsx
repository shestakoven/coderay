import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PROTECTION, type ChatPick, type EngineId, type SessionView } from '@ide/protocol';
import { initialChatState } from '../src/chat/chat-state';
import { ChatPanel } from '../src/chat/ChatPanel';
import { ImageStore } from '../src/chat/image-store';
import { ModelControls, ModelMenu } from '../src/chat/ModelControls';
import { ENGINE_STATES, THREE_ENGINES } from './model-fixtures';

const SONNET: ChatPick = { engine: 'claude', modelChoice: 'sonnet', effort: 'medium' };
const menu = (started: boolean, overrides: { recent?: string[]; initialQuery?: string; models?: typeof THREE_ENGINES } = {}) => renderToStaticMarkup(
  <ModelMenu models={overrides.models ?? THREE_ENGINES} engines={ENGINE_STATES} current={SONNET} started={started} recent={overrides.recent ?? []} initialQuery={overrides.initialQuery ?? ''} onChoose={() => undefined} onClose={() => undefined} />,
);
const texts = (html: string, className: string) => [...html.matchAll(new RegExp(`class="${className}"[^>]*>([^<]*)<`, 'g'))].map((match) => match[1]);
const options = (html: string) => [...html.matchAll(/<div id="([^"]+)" role="option" aria-selected="(true|false)"/g)].map((match) => [match[1], match[2]]);

describe('ModelMenu', () => {
  it('groups the models under their engines and says what keeps an engine that is not ready from working', () => {
    const html = menu(false);
    expect([texts(html, 'model-engine'), texts(html, 'model-state signed-out'), texts(html, 'model-state old'), texts(html, 'model-hint')]).toEqual([
      ['Claude', 'Codex', 'opencode'], ['signed out'], ['too old'], ['Sign in: run codex login', 'Update to ≥ 1.19'],
    ]);
  });

  it('greys the models of other engines once the chat is in use, each offering a new chat, and only then', () => {
    expect([menu(true), menu(false)].map((html) => [(html.match(/class="model-row( sel)? locked"/g) ?? []).length, texts(html, 'model-new').length]))
      .toEqual([[3, 3], [0, 0]]);
  });

  it('marks the current model and no other, also by name for a screen reader, starts the keyboard on it and points the search box at it', () => {
    const html = menu(false);
    const selected = /<div id="([^"]+)" role="option" aria-selected="true"[^>]*>(.*?)<\/div>/.exec(html);
    expect([
      selected?.[2]?.includes('Sonnet 5.5'), selected?.[2]?.includes('<svg'), selected?.[2]?.includes('<span class="visually-hidden"> (current)</span>'),
      html.match(/class="model-check"><svg/g)?.length, html.match(/class="visually-hidden"/g)?.length, html.includes(`aria-activedescendant="${selected?.[1]}"`),
      html.includes('<div class="model-menu" role="dialog" aria-label="Choose a model"'),
    ]).toEqual([true, true, true, 1, 1, true, true]);
  });

  it('gives a model shown both among the recent ones and in its engine two options of their own, and starts on the one in its engine', () => {
    const shown = options(menu(false, { recent: ['sonnet'] }));
    expect([new Set(shown.map(([id]) => id)).size, shown.length, shown.findIndex(([, selected]) => selected === 'true')]).toEqual([6, 6, 1]);
  });

  it('underlines what matches the typed words, in the name and the id, and starts on the first match', () => {
    const html = menu(false, { initialQuery: 'claude beta' });
    expect([options(html).map(([, selected]) => selected), /<u>Claude<\/u>/.test(html), /anthropic\/<u>claude<\/u>-3\.5:<u>beta<\/u>/.test(html)]).toEqual([['true'], true, true]);
  });

  it('says when nothing matches in a live region kept in place, but not when an engine named by the query explains why it lists nothing, in a group of its own', () => {
    const noCodex = THREE_ENGINES.filter((model) => model.engine !== 'codex');
    const [nothing, codex] = [menu(false, { initialQuery: ' zzz ' }), menu(false, { initialQuery: 'codex', models: noCodex })];
    const heads = (html: string) => [...html.matchAll(/class="model-group-head" id="([^"]+)" aria-hidden="true"/g)].map((match) => html.includes(`role="group" aria-labelledby="${match[1]}"`));
    expect([texts(nothing, 'model-empty'), texts(codex, 'model-empty'), texts(codex, 'model-hint'), nothing.includes('aria-activedescendant'), heads(codex), heads(menu(false))])
      .toEqual([['No model matches “zzz”'], [''], ['Sign in: run codex login'], false, [true], [true, true, true]]);
  });

  it("names the account each engine runs under in its header and in its group's name for a screen reader, and nothing for an engine with no account of CodeRay's", () => {
    const engines = ENGINE_STATES.map((status) => (status.engine === 'codex' ? { ...status, account: 'work@example.com · Plus' } : status));
    const html = renderToStaticMarkup(<ModelMenu models={THREE_ENGINES} engines={engines} current={SONNET} started={false} recent={[]} initialQuery="" onChoose={() => undefined} onClose={() => undefined} />);
    const groupNames = [...html.matchAll(/class="model-group-head" id="[^"]+"[^>]*>(.*?)<\/div>/g)].map((match) => match[1]!.replace(/<[^>]+>/g, ''));
    expect([texts(html, 'model-account'), groupNames.map((name) => name.startsWith('Codex, account work@example.com · Plus'))]).toEqual([['work@example.com · Plus'], [false, true, false]]);
  });

  it('keeps the header of an engine whose models are still coming, saying so, whatever is typed, so no query reads as matching nothing', () => {
    const noCodex = THREE_ENGINES.filter((model) => model.engine !== 'codex');
    const html = (initialQuery: string) => renderToStaticMarkup(
      <ModelMenu models={noCodex} engines={[]} pending={['codex']} current={SONNET} started={false} recent={[]} initialQuery={initialQuery} onChoose={() => undefined} onClose={() => undefined} />,
    );
    expect([texts(html(''), 'model-engine'), texts(html(''), 'model-state loading'), texts(html('son'), 'model-engine'), texts(html('zzz'), 'model-engine'), texts(html('zzz'), 'model-empty')])
      .toEqual([['Claude', 'Codex', 'opencode'], ['loading models'], ['Claude', 'Codex'], ['Codex'], ['']]);
  });

  it('says when an engine that runs could not list its models and offers to ask again, and leaves one that cannot run to its own reason', () => {
    const noCodex = THREE_ENGINES.filter((model) => model.engine !== 'codex');
    const html = (state: 'ready' | 'missing') => renderToStaticMarkup(
      <ModelMenu
        models={noCodex} engines={[{ engine: 'codex', state, hint: null }]} failed={['codex']} onRetry={() => undefined} current={SONNET} started={false} recent={[]}
        initialQuery="" onChoose={() => undefined} onClose={() => undefined}
      />,
    );
    expect([texts(html('ready'), 'model-hint'), /<button type="button" class="model-retry">Retry<\/button>/.test(html('ready')), html('missing').includes('model-unlisted')])
      .toEqual([['Could not list Codex models'], true, false]);
  });
});

describe('ModelControls', () => {
  it('keeps in view, disabled, the effort a chat still sends when its model lists none, and shows no effort before there is a model', () => {
    const controls = (current: ChatPick | null) => renderToStaticMarkup(
      <ModelControls current={current} models={THREE_ENGINES} engines={ENGINE_STATES} started={false} enabled send={() => true} />,
    );
    const haiku = controls({ engine: 'claude', modelChoice: 'haiku', effort: 'medium' });
    expect([/<select aria-label="Effort"[^>]*disabled=""[^>]*><option value="medium" selected="">medium<\/option><\/select>/.test(haiku), controls(null).includes('aria-label="Effort"')])
      .toEqual([true, false]);
  });

  it('names the chosen model on its button, or asks for one in the accent while the project has no chat, and says the menu is closed', () => {
    const button = (current: ChatPick | null) => /<button[^>]*class="model-button[^"]*"[^>]*>(.*?)<\/button>/.exec(renderToStaticMarkup(
      <ModelControls current={current} models={THREE_ENGINES} engines={ENGINE_STATES} started={false} enabled send={() => true} />,
    ))?.[0] ?? '';
    const [chosen, none, claudeDefault] = [button(SONNET), button(null), button({ engine: 'claude', modelChoice: null, effort: null })];
    expect([
      texts(chosen, 'model-button-label'), texts(none, 'model-button-label'), [chosen, none, claudeDefault].map((html) => html.includes('model-button needed')),
      chosen.includes('aria-expanded="false"'), chosen.includes('aria-haspopup="dialog"'),
    ]).toEqual([['Sonnet 5.5'], ['Select model'], [false, true, false], true, true]);
  });
});

describe('ChatPanel', () => {
  it('asks for a model before the first message, or the terminal view, when the core says a chat needs one, and not when a core older than the engines says nothing', () => {
    const composer = (next: ChatPick | null | undefined) => {
      const html = renderToStaticMarkup(
        <ChatPanel
          chat={initialChatState} chats={{ activeId: null, sessions: [], models: [], engines: [], next }} send={() => true} onClearFilter={() => undefined}
          onDismissError={() => undefined} prompts={[]} promptAnchored={false} onAnswerPrompt={() => undefined} onFocusTargets={() => undefined} dialog={null}
          view="chat" onView={() => undefined} terminal={null} images={new ImageStore(() => true)} imagesLive={false}
        />,
      );
      const terminal = html.split('<button').find((button) => button.includes('Terminal</button>'))?.split('>')[0] ?? '';
      return [/<textarea[^>]*placeholder="([^"]*)"/.exec(html)?.[1], /<button class="composer-action send"[^>]*title="([^"]*)"/.exec(html)?.[1], terminal.includes('disabled=""'), /title="([^"]*)"/.exec(terminal)?.[1]];
    };
    expect([composer(null), composer(undefined)]).toEqual([
      ['Choose a model to start the agent', 'Choose a model first', true, 'Choose a model first'],
      ['Message the agent (Enter sends, Shift+Enter adds a line)', 'Send (Enter)', false, 'Claude Code&#x27;s own terminal interface: every slash command works'],
    ]);
  });

  it('names the engine and how it guards writes in the header, calls a refused Codex chat refused, and offers no terminal for Codex', () => {
    const header = (engine: EngineId) => {
      const session: SessionView = { id: 's', engine, engineSessionId: 'c', status: 'refused', model: null, modelChoice: engine === 'codex' ? 'codex:gpt-6-luna' : 'sonnet', effort: 'medium', cliVersion: null, permissionMode: null, startedAt: 1 };
      const html = renderToStaticMarkup(
        <ChatPanel
          chat={{ ...initialChatState, session }} chats={{ activeId: 's', sessions: [], models: [], engines: [] }} send={() => true} onClearFilter={() => undefined}
          onDismissError={() => undefined} prompts={[]} promptAnchored={false} onAnswerPrompt={() => undefined} onFocusTargets={() => undefined} dialog={null}
          view="chat" onView={() => undefined} terminal={null} images={new ImageStore(() => true)} imagesLive={false}
        />,
      );
      return [
        /class="engine-chip"[^>]*>([^<]*)<span class="engine-protection">([^<]*)</.exec(html)?.slice(1),
        /class="chat-status refused"[^>]*><i class="status-dot"><\/i>([^<]*)</.exec(html)?.[1],
        html.includes('Terminal</button>'),
      ];
    };
    expect([header('claude'), header('codex')]).toEqual([
      [['Claude', 'Hook'], 'hook off', true],
      [['Codex', 'OS sandbox + approvals'], 'refused', false],
    ]);
  });

  it("lets the keyboard and a screen reader reach the chip's explanation, and gives a narrow header the caption's short word", () => {
    const session: SessionView = { id: 's', engine: 'codex', engineSessionId: 'c', status: 'running', model: null, modelChoice: 'codex:gpt-6-luna', effort: 'medium', cliVersion: null, permissionMode: null, startedAt: 1 };
    const html = renderToStaticMarkup(
      <ChatPanel
        chat={{ ...initialChatState, session }} chats={{ activeId: 's', sessions: [], models: [], engines: [] }} send={() => true} onClearFilter={() => undefined}
        onDismissError={() => undefined} prompts={[]} promptAnchored={false} onAnswerPrompt={() => undefined} onFocusTargets={() => undefined} dialog={null}
        view="chat" onView={() => undefined} terminal={null} images={new ImageStore(() => true)} imagesLive={false}
      />,
    );
    const why = /<span class="engine-chip" tabindex="0" aria-describedby="([^"]+)">/.exec(html)?.[1];
    expect([html.includes(`<span id="${why}">${PROTECTION.codex.title}</span>`), /class="engine-short" aria-hidden="true">([^<]*)</.exec(html)?.[1]]).toEqual([true, 'Sandbox']);
  });
});
