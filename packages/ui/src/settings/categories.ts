import type { IconName } from '../layout/Icon';

export type CategoryId = 'agent' | 'mcp' | 'paths' | 'accounts' | 'appearance';

export interface Category {
  id: CategoryId;
  label: string;
  icon: IconName;
  intro: string;
}

export const CATEGORIES: Category[] = [
  { id: 'agent', label: 'Agent control', icon: 'shield', intro: 'What happens when the agent writes outside the plan you approved, and which plans go through without a click.' },
  { id: 'mcp', label: 'MCP servers', icon: 'server', intro: 'Tools the agent can call. Project servers run only after you approve them on this machine.' },
  { id: 'paths', label: 'Paths', icon: 'folder', intro: 'Which files CodeRay protects, which it only records, and which places outside the project the agent may write to.' },
  { id: 'accounts', label: 'Accounts', icon: 'user', intro: 'The Claude sign-in every agent in CodeRay runs under.' },
  { id: 'appearance', label: 'Appearance', icon: 'sliders', intro: 'How CodeRay looks on this machine. Changes apply at once and stay local.' },
];

export type BlockId =
  | 'mode' | 'auto-approve'
  | 'guarded' | 'harness' | 'outside-allowed'
  | 'mcp-servers' | 'claude-code-servers'
  | 'accounts'
  | 'density' | 'font-size' | 'reduced-motion' | 'canvas-dots';

export interface Block {
  id: BlockId;
  category: CategoryId;
  title: string;
  help: string;
  keywords: string[];
}

export const BLOCKS: Block[] = [
  { id: 'mode', category: 'agent', title: 'When the agent writes outside the plan', help: 'Choose whether such a write is blocked, asked about, or allowed and flagged.', keywords: ['control mode', 'block', 'ask', 'allow', 'flag', 'out of plan', 'policy', 'watchdog'] },
  { id: 'auto-approve', category: 'agent', title: 'Approve small plans automatically', help: 'Plans that touch only a few ordinary files start without asking.', keywords: ['auto approve', 'automatic', 'plan', 'files', 'limit'] },
  { id: 'guarded', category: 'paths', title: 'Guarded paths', help: 'Always enforced, even when gitignored.', keywords: ['protect', 'gitignore', 'env', 'secrets', 'hooks', 'enforced', 'glob', 'pattern'] },
  { id: 'harness', category: 'paths', title: 'Harness paths', help: 'Plugin state CodeRay records but never enforces.', keywords: ['plugin', 'state', 'recorded', 'omc', 'gitignore', 'glob', 'pattern'] },
  { id: 'outside-allowed', category: 'paths', title: 'Allowed outside the project', help: 'Places the agent may write to without leaving the plan.', keywords: ['outside', 'absolute', 'home', 'temp', 'directory', 'folder'] },
  { id: 'mcp-servers', category: 'mcp', title: 'Servers you added', help: 'Configured in CodeRay for one project or for all of them. Changes apply when the session restarts.', keywords: ['mcp', 'server', 'tool', 'stdio', 'http', 'command', 'url', 'env', 'approve', 'trust'] },
  { id: 'claude-code-servers', category: 'mcp', title: 'From Claude Code', help: 'Loaded by Claude Code itself. Edit them with claude mcp.', keywords: ['claude code', 'plugin', 'mcp', 'claude mcp', 'read only'] },
  { id: 'accounts', category: 'accounts', title: 'Claude accounts', help: 'Choose the sign-in the agent runs under, or add another.', keywords: ['account', 'sign in', 'login', 'email', 'system', 'claude', 'oauth'] },
  { id: 'density', category: 'appearance', title: 'Density', help: 'How much room rows, tabs and panels take.', keywords: ['compact', 'comfortable', 'spacing', 'rows'] },
  { id: 'font-size', category: 'appearance', title: 'Text size', help: 'Scales the text across CodeRay.', keywords: ['font', 'size', 'zoom', 'larger', 'smaller', 'text'] },
  { id: 'reduced-motion', category: 'appearance', title: 'Reduce motion', help: 'Turns off animations and transitions.', keywords: ['animation', 'motion', 'accessibility', 'transition'] },
  { id: 'canvas-dots', category: 'appearance', title: 'Dots on the map', help: 'The dotted grid behind the map canvas.', keywords: ['grid', 'background', 'canvas', 'map', 'dots'] },
];

export const DEFAULT_CATEGORY: CategoryId = 'agent';

export const isCategoryId = (value: unknown): value is CategoryId => CATEGORIES.some((category) => category.id === value);

export const categoryOf = (id: CategoryId): Category => CATEGORIES.find((category) => category.id === id)!;

export const blocksOf = (id: CategoryId): Block[] => BLOCKS.filter((block) => block.category === id);

// Every word of the query must appear somewhere in the block's text; `extra` adds live words such as server names.
export function matchBlocks(query: string, extra: Partial<Record<BlockId, string[]>> = {}): Block[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return BLOCKS;
  return BLOCKS.filter((block) => {
    const haystack = [block.title, block.help, ...block.keywords, ...(extra[block.id] ?? [])].join('\n').toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export function countByCategory(blocks: Block[]): Record<CategoryId, number> {
  const counts: Record<CategoryId, number> = { agent: 0, mcp: 0, paths: 0, accounts: 0, appearance: 0 };
  for (const block of blocks) counts[block.category] += 1;
  return counts;
}
