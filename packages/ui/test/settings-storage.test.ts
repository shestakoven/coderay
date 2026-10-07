import { describe, expect, it } from 'vitest';
import { loadCategory, loadScope, saveCategory, saveScope } from '../src/settings/storage';
import { blockedStorage, memoryStorage } from './memory-storage';

const CATEGORY_KEY = 'ide.settings.category';
const SCOPE_KEY = 'ide.settings.scope';

describe('remembered category', () => {
  it.each(['agent', 'mcp', 'paths', 'accounts', 'appearance'])('reads back the stored category %j', (id) => {
    expect(loadCategory(memoryStorage({ [CATEGORY_KEY]: id }))).toBe(id);
  });

  it.each(['search', 'MCP', '', 'mcp-servers'])('opens Agent control for the unknown stored value %j', (value) => {
    expect(loadCategory(memoryStorage({ [CATEGORY_KEY]: value }))).toBe('agent');
  });

  it('opens Agent control when nothing is stored, the store is blocked, or there is none', () => {
    expect(loadCategory(memoryStorage({ [SCOPE_KEY]: 'mcp' }))).toBe('agent');
    expect(loadCategory(blockedStorage())).toBe('agent');
    expect(loadCategory(undefined)).toBe('agent');
  });

  it('writes the category under its own key', () => {
    const storage = memoryStorage();
    saveCategory(storage, 'appearance');
    expect(storage.getItem(CATEGORY_KEY)).toBe('appearance');
    expect(storage.length).toBe(1);
    expect(loadCategory(storage)).toBe('appearance');
  });

  it('survives a store that refuses writes, or no store at all', () => {
    expect(() => saveCategory(blockedStorage(), 'mcp')).not.toThrow();
    expect(() => saveCategory(undefined, 'mcp')).not.toThrow();
  });
});

describe('remembered scope', () => {
  it('reads back All projects', () => {
    expect(loadScope(memoryStorage({ [SCOPE_KEY]: 'ide' }))).toBe('ide');
  });

  it.each(['project', 'CodeRay', 'all', ''])('falls back to This project for the stored value %j', (value) => {
    expect(loadScope(memoryStorage({ [SCOPE_KEY]: value }))).toBe('project');
  });

  it('falls back to This project when nothing is stored, the store is blocked, or there is none', () => {
    expect(loadScope(memoryStorage({ [CATEGORY_KEY]: 'ide' }))).toBe('project');
    expect(loadScope(blockedStorage())).toBe('project');
    expect(loadScope(undefined)).toBe('project');
  });

  it.each(['ide', 'project'] as const)('writes the scope %s under its own key', (scope) => {
    const storage = memoryStorage();
    saveScope(storage, scope);
    expect(storage.getItem(SCOPE_KEY)).toBe(scope);
    expect(storage.length).toBe(1);
    expect(loadScope(storage)).toBe(scope);
  });

  it('survives a store that refuses writes, or no store at all', () => {
    expect(() => saveScope(blockedStorage(), 'ide')).not.toThrow();
    expect(() => saveScope(undefined, 'ide')).not.toThrow();
  });
});
