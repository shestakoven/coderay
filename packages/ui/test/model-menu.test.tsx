import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatPick } from '@ide/protocol';
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

  it('marks the current model, starts the keyboard on it and points the search box at it', () => {
    const html = menu(false);
    const selected = /<div id="([^"]+)" role="option" aria-selected="true"[^>]*>(.*?)<\/div>/.exec(html);
    expect([selected?.[2]?.includes('Sonnet 5.5'), selected?.[2]?.includes('<svg'), html.includes(`aria-activedescendant="${selected?.[1]}"`)]).toEqual([true, true, true]);
  });

  it('gives a model shown both among the recent ones and in its engine two options of their own, and starts on the one in its engine', () => {
    const shown = options(menu(false, { recent: ['sonnet'] }));
    expect([new Set(shown.map(([id]) => id)).size, shown.length, shown.findIndex(([, selected]) => selected === 'true')]).toEqual([6, 6, 1]);
  });

  it('underlines what matches the typed words, in the name and the id, and starts on the first match', () => {
    const html = menu(false, { initialQuery: 'claude beta' });
    expect([options(html).map(([, selected]) => selected), /<u>Claude<\/u>/.test(html), /anthropic\/<u>claude<\/u>-3\.5:<u>beta<\/u>/.test(html)]).toEqual([['true'], true, true]);
  });

  it('says when nothing matches, but not when an engine named by the query explains why it lists nothing', () => {
    const noCodex = THREE_ENGINES.filter((model) => model.engine !== 'codex');
    const [nothing, codex] = [menu(false, { initialQuery: ' zzz ' }), menu(false, { initialQuery: 'codex', models: noCodex })];
    expect([texts(nothing, 'model-empty'), texts(codex, 'model-empty'), texts(codex, 'model-hint'), nothing.includes('aria-activedescendant')])
      .toEqual([['No model matches “zzz”'], [], ['Sign in: run codex login'], false]);
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
      chosen.includes('aria-expanded="false"'), chosen.includes('aria-haspopup="listbox"'),
    ]).toEqual([['Sonnet 5.5'], ['Select model'], [false, true, false], true, true]);
  });
});
