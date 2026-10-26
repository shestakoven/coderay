import { describe, expect, it } from 'vitest';
import { toolClass } from '../../src/gate/tools';

describe('toolClass', () => {
  it.each([
    ['mcp__idecore__propose_plan', 'ide'],
    ['mcp__serena__replace_symbol_body', 'mcp'],
    ['Write', 'file-writer'],
    ['Edit', 'file-writer'],
    ['NotebookEdit', 'file-writer'],
    ['Bash', 'shell'],
    ['Monitor', 'shell'],
    ['Task', 'subagent'],
    ['Agent', 'subagent'],
    ['Read', 'read'],
    ['Grep', 'read'],
    ['WebFetch', 'read'],
    ['TaskStop', 'read'],
    ['ToolSearch', 'read'],
    ['AskUserQuestion', 'interactive'],
    ['ExitPlanMode', 'interactive'],
    ['SendMessage', 'unknown'],
    ['BrandNewTool', 'unknown'],
  ])('%s is %s', (name, expected) => {
    expect(toolClass(name)).toBe(expected);
  });
});
