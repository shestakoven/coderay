import type { GatePromptView, GateTarget } from '@ide/protocol';

export const promptTarget = (prompt: GatePromptView): GateTarget | null => prompt.targets.find((target) => !target.inScope) ?? null;

export const agentReason = (prompt: GatePromptView): string => prompt.reason ?? 'The agent wrote nothing before this call.';

export function promptHint(prompt: GatePromptView): string {
  const target = promptTarget(prompt);
  if (!target) return `The IDE does not know the tool ${prompt.tool}. The call waits for your answer.`;
  const why = {
    enforced: 'is not in the approved plan',
    outside: 'is outside the project',
    unresolved: 'cannot be known before the call runs',
    'all-tracked': 'rewrites every tracked file',
  }[target.kind];
  return `${target.path} ${why}. The call waits for your answer.`;
}

export function prefixed(prefix: string, text: string, maxLines = 12): string {
  const lines = text.replace(/\n$/, '').split('\n');
  const shown = lines.slice(0, maxLines).map((line) => `${prefix}${line}`);
  const more = lines.length - maxLines;
  return more > 0 ? [...shown, `${prefix}… ${more} more ${more === 1 ? 'line' : 'lines'}`].join('\n') : shown.join('\n');
}

export function mapAnchor(prompt: GatePromptView, nodeIds: Set<string>): string | null {
  const target = promptTarget(prompt);
  if (!target?.componentId) return null;
  if (nodeIds.has(target.path)) return target.path;
  return nodeIds.has(target.componentId) ? target.componentId : null;
}
