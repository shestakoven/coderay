import { describe, expect, it } from 'vitest';
import { BLOCKS, CATEGORIES, blocksOf, categoryOf, countByCategory, isCategoryId, matchBlocks, type CategoryId } from '../src/settings/categories';

const ids = (blocks: { id: string }[]): string[] => blocks.map((block) => block.id);
const CATEGORY_IDS: CategoryId[] = ['agent', 'mcp', 'paths', 'accounts', 'appearance'];
const NONE = { agent: 0, mcp: 0, paths: 0, accounts: 0, appearance: 0 };

describe('settings categories', () => {
  it('lists the categories in rail order', () => {
    expect(CATEGORIES.map((category) => category.id)).toEqual(CATEGORY_IDS);
  });

  it.each(CATEGORY_IDS)('recognises %j as a category id', (id) => {
    expect(isCategoryId(id)).toBe(true);
  });

  it.each(['', 'Agent', 'mcp ', 'search', 'claude-code-servers', null, undefined, 1, {}])('does not take %j for a category id', (value) => {
    expect(isCategoryId(value)).toBe(false);
  });

  it.each(CATEGORY_IDS)('finds the %s category entry by its id', (id) => {
    expect(categoryOf(id)).toBe(CATEGORIES.find((category) => category.id === id));
  });

  it.each([
    ['agent', ['mode', 'auto-approve']],
    ['mcp', ['mcp-servers', 'claude-code-servers']],
    ['paths', ['guarded', 'harness', 'outside-allowed']],
    ['accounts', ['accounts']],
    ['appearance', ['density', 'font-size', 'reduced-motion', 'canvas-dots']],
  ] as const)('gives the %s category its blocks in page order', (id, expected) => {
    expect(ids(blocksOf(id))).toEqual(expected);
  });

  it('puts every block in exactly one category', () => {
    expect(CATEGORY_IDS.flatMap((id) => ids(blocksOf(id))).sort()).toEqual(ids(BLOCKS).sort());
  });
});

describe('matchBlocks', () => {
  it.each(['', '   ', '\t\n '])('returns every block for the blank query %j', (query) => {
    expect(ids(matchBlocks(query))).toEqual(ids(BLOCKS));
  });

  it('finds a block by a word of its title', () => {
    expect(ids(matchBlocks('guarded'))).toEqual(['guarded']);
  });

  it('ignores case on both sides', () => {
    expect(ids(matchBlocks('GITIGNORE'))).toEqual(['guarded', 'harness']);
    expect(ids(matchBlocks('GuArDeD'))).toEqual(['guarded']);
  });

  it('matches part of a word', () => {
    expect(ids(matchBlocks('gitig'))).toEqual(['guarded', 'harness']);
  });

  it('finds nothing for a word no block mentions', () => {
    expect(matchBlocks('zzqx')).toEqual([]);
  });

  it('needs every word, each found in the title, the help or the keywords', () => {
    // "Allowed" is in the title, "leaving" only in the help, "absolute" only in the keywords.
    expect(ids(matchBlocks('allowed leaving absolute'))).toEqual(['outside-allowed']);
  });

  it('ANDs the words instead of ORing them', () => {
    expect(ids(matchBlocks('plugin'))).toEqual(['harness', 'claude-code-servers']);
    expect(ids(matchBlocks('mcp'))).toEqual(['mcp-servers', 'claude-code-servers']);
    expect(ids(matchBlocks('plugin mcp'))).toEqual(['claude-code-servers']);
    expect(ids(matchBlocks('mcp   plugin'))).toEqual(['claude-code-servers']);
  });

  it('drops a block as soon as one word is missing from it', () => {
    expect(matchBlocks('guarded zzqx')).toEqual([]);
  });

  it('keeps the page order of blocks rather than the rail order of categories', () => {
    // harness (Paths) precedes the Claude Code block (MCP servers) in BLOCKS, while MCP comes first on the rail.
    expect(ids(matchBlocks('plugin'))).toEqual(['harness', 'claude-code-servers']);
  });

  it('finds a block by an extra word given for it, case-insensitively', () => {
    expect(matchBlocks('context7')).toEqual([]);
    expect(ids(matchBlocks('context7', { 'mcp-servers': ['Context7'] }))).toEqual(['mcp-servers']);
  });

  it('counts extra words only for their own block', () => {
    expect(ids(matchBlocks('linear', { 'claude-code-servers': ['linear'] }))).toEqual(['claude-code-servers']);
    expect(ids(matchBlocks('server linear', { 'claude-code-servers': ['linear'] }))).toEqual([]);
  });

  it('combines extra words with the block text', () => {
    expect(ids(matchBlocks('server context7', { 'mcp-servers': ['context7'], accounts: ['context7'] }))).toEqual(['mcp-servers']);
  });
});

describe('countByCategory', () => {
  it('reports zero for every category when nothing matched', () => {
    expect(countByCategory([])).toEqual(NONE);
  });

  it('counts the blocks of every category', () => {
    expect(countByCategory(BLOCKS)).toEqual({ agent: 2, mcp: 2, paths: 3, accounts: 1, appearance: 4 });
  });

  it('counts a search result per category with zeros for the rest', () => {
    expect(countByCategory(matchBlocks('plugin'))).toEqual({ ...NONE, paths: 1, mcp: 1 });
    expect(countByCategory(matchBlocks('gitignore'))).toEqual({ ...NONE, paths: 2 });
  });
});
