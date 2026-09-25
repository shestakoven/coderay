import type { AskQuestion } from '@ide/protocol';

export interface AskSelection {
  chosen: string[];
  other: string;
}

export function askAnswers(questions: AskQuestion[], selections: AskSelection[]): { answers: Record<string, string> } | { error: string } {
  const answers: Record<string, string> = {};
  for (const [index, question] of questions.entries()) {
    const selection = selections[index] ?? { chosen: [], other: '' };
    const other = selection.other.trim();
    const value = question.multiSelect ? [...selection.chosen, ...(other ? [other] : [])].join(', ') : other || (selection.chosen[0] ?? '');
    if (value === '') return { error: `Answer "${question.question}" first.` };
    answers[question.question] = value;
  }
  return { answers };
}
