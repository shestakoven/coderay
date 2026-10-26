export type ToolClass = 'ide' | 'file-writer' | 'shell' | 'subagent' | 'read' | 'mcp' | 'interactive' | 'unknown';

export const FILE_PATH_FIELD: Readonly<Record<string, string>> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

const SHELL_TOOLS = new Set(['Bash', 'Monitor']);
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']);
const READ_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'WebFetch', 'WebSearch', 'Skill',
  'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskStop', 'ListAgents', 'ReportFindings',
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool', 'WaitForMcpServers',
  'ToolSearch',
]);

export function toolClass(name: string): ToolClass {
  if (name.startsWith('mcp__idecore__')) return 'ide';
  if (name.startsWith('mcp__')) return 'mcp';
  if (Object.hasOwn(FILE_PATH_FIELD, name)) return 'file-writer';
  if (SHELL_TOOLS.has(name)) return 'shell';
  if (SUBAGENT_TOOLS.has(name)) return 'subagent';
  if (INTERACTIVE_TOOLS.has(name)) return 'interactive';
  if (READ_TOOLS.has(name)) return 'read';
  return 'unknown';
}
