import type { AskQuestion, PromptAnswer, PromptBody } from '@ide/protocol';
import { isRecord } from '../json';

export const PROMPT_TOOLS = ['AskUserQuestion', 'ExitPlanMode'];

// The CLI's own text for a rejected call (every rejection in the spike recordings); c22d's model distrusted a custom one.
export const CLI_REJECTION = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.\n\nNote: The user's next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they'd prefer you to work, consider saving that to memory for future sessions.";

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function parsePromptBody(toolName: string | null, input: unknown): PromptBody | null {
  const record = isRecord(input) ? input : {};
  if (toolName === 'ExitPlanMode') return typeof record.plan === 'string' ? { tool: 'ExitPlanMode', plan: record.plan } : null;
  if (toolName !== 'AskUserQuestion' || !Array.isArray(record.questions)) return null;
  const questions: AskQuestion[] = [];
  for (const question of record.questions) {
    if (!isRecord(question) || typeof question.question !== 'string' || !Array.isArray(question.options)) return null;
    questions.push({
      question: question.question,
      header: text(question.header),
      multiSelect: question.multiSelect === true,
      options: question.options.filter(isRecord).map((option) => ({ label: text(option.label), description: text(option.description) })),
    });
  }
  return questions.length > 0 ? { tool: 'AskUserQuestion', questions } : null;
}

export function answerProblem(body: PromptBody, answer: PromptAnswer): string | null {
  if (answer.kind === 'deny') return null;
  if (body.tool !== 'AskUserQuestion') return answer.kind === 'allow' ? null : 'Approve or decline.';
  if (answer.kind !== 'answers') return 'Answer the questions or decline them.';
  const unanswered = body.questions.find(
    (question) => !Object.hasOwn(answer.answers, question.question) || !answer.answers[question.question]?.trim(),
  );
  return unanswered ? `Answer "${unanswered.question}" first.` : null;
}

export function promptResponse(input: unknown, answer: PromptAnswer): object {
  if (answer.kind === 'deny') return { behavior: 'deny', message: answer.feedback.trim() || CLI_REJECTION };
  const original = isRecord(input) ? input : {};
  return { behavior: 'allow', updatedInput: answer.kind === 'answers' ? { ...original, answers: answer.answers } : original };
}
