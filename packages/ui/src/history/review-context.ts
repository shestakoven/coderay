import type { ChatItem, EventResolution, HistoryView, ToolStatus, WatchdogEventView } from '@ide/protocol';
import type { ReviewItem, ReviewSection } from './review-model';

export interface ContextTool {
  id: string;
  tool: string;
  summary: string;
  status: ToolStatus | null;
  inChat: boolean;
}

export interface ReviewContext {
  title: string;
  rationale: string | null;
  summary: { text: string | null; pending: boolean } | null;
  reason: string | null;
  decision: string | null;
  tools: ContextTool[];
}

const DECISION: Partial<Record<EventResolution, string>> = {
  pending: 'This is waiting for your decision in the chat.',
  kept: 'You chose to keep it.',
  reverted: 'You reverted it.',
  'plan-expanded': 'You added it to the plan.',
  'relabeled-human': 'You said it was your own edit.',
  flagged: 'You flagged it.',
  mixed: 'You decided file by file.',
};

function titleOf(section: ReviewSection): string {
  if (section.outOfPlan) return 'Outside the plan';
  if (section.key === 'external') return 'Changed outside the agent';
  return section.stepNo ? `Step ${section.stepNo} of ${section.stepTotal} · ${section.title}` : section.title;
}

function reasonOf(section: ReviewSection, event: WatchdogEventView | undefined): string | null {
  if (section.key === 'external') return 'The IDE saw this change but it did not come from the agent\'s tracked tool calls. You or another tool may have made it.';
  if (!section.outOfPlan) return null;
  const parts = ['The agent wrote this file, but no step of the approved plan lists it.'];
  if (event?.kind === 'fail-open') parts.push('The write guard was not running, so the edit was not checked beforehand.');
  if (event?.unknownOrigin) parts.push('The file changed while the IDE was not running, so who made the change is unknown.');
  return parts.join(' ');
}

export function contextOf(section: ReviewSection, file: ReviewItem, history: HistoryView, items: Record<string, ChatItem | undefined>): ReviewContext {
  const event = history.events.filter((candidate) => file.eventIds.includes(candidate.id)).sort((a, b) => b.ts - a.ts)[0];
  const known = new Map((event?.toolCalls ?? []).map((call) => [call.toolUseId, call]));
  const tools = file.toolUseIds.map((id): ContextTool | null => {
    const item = items[id];
    if (item?.kind === 'tool') return { id, tool: item.tool, summary: item.summary, status: item.status, inChat: true };
    const call = known.get(id);
    return call ? { id, tool: call.tool, summary: call.summary, status: null, inChat: false } : null;
  }).filter((tool): tool is ContextTool => tool !== null);
  return {
    title: titleOf(section),
    rationale: section.rationale,
    summary: section.summary ? { text: section.summary.text, pending: section.summary.pending } : null,
    reason: reasonOf(section, event),
    decision: event && section.outOfPlan ? DECISION[event.resolution] ?? null : null,
    tools,
  };
}

export const hasContext = (context: ReviewContext): boolean =>
  context.rationale !== null || context.summary !== null || context.reason !== null || context.tools.length > 0;
