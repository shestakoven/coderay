import { describe, expect, it } from 'vitest';
import { answerProblem, CLI_REJECTION, parsePromptBody, promptResponse } from '../../src/agent/prompts';

const questions = {
  questions: [
    { question: 'Which color?', header: 'Color', options: [{ label: 'red', description: 'warm' }, { label: 'blue' }], multiSelect: false },
    { question: 'Which sizes?', header: 'Sizes', options: [{ label: 'S' }, { label: 'L' }], multiSelect: true },
  ],
};
const askBody = parsePromptBody('AskUserQuestion', questions)!;

describe('parsePromptBody', () => {
  it('reads the questions, options and multi-select flag of AskUserQuestion', () => {
    expect(askBody).toEqual({
      tool: 'AskUserQuestion',
      questions: [
        { question: 'Which color?', header: 'Color', options: [{ label: 'red', description: 'warm' }, { label: 'blue', description: '' }], multiSelect: false },
        { question: 'Which sizes?', header: 'Sizes', options: [{ label: 'S', description: '' }, { label: 'L', description: '' }], multiSelect: true },
      ],
    });
  });

  it('reads the plan of ExitPlanMode', () => {
    expect(parsePromptBody('ExitPlanMode', { plan: '1. Create plan.txt' })).toEqual({ tool: 'ExitPlanMode', plan: '1. Create plan.txt' });
  });

  it('returns null for an input it cannot show or a tool it does not ask about', () => {
    expect([parsePromptBody('AskUserQuestion', { questions: 'x' }), parsePromptBody('Write', { file_path: 'a' }), parsePromptBody('EnterPlanMode', {})])
      .toEqual([null, null, null]);
  });
});

describe('answerProblem', () => {
  it('names the first question left without an answer', () => {
    expect(answerProblem(askBody, { kind: 'answers', answers: { 'Which color?': 'blue', 'Which sizes?': ' ' } })).toBe('Answer "Which sizes?" first.');
  });
});

describe('promptResponse', () => {
  it('allows the call with the answers added to the original input', () => {
    expect(promptResponse(questions, { kind: 'answers', answers: { 'Which color?': 'blue', 'Which sizes?': 'S, L' } })).toEqual({
      behavior: 'allow',
      updatedInput: { ...questions, answers: { 'Which color?': 'blue', 'Which sizes?': 'S, L' } },
    });
  });

  it("denies the call with the user's feedback", () => {
    expect(promptResponse({ plan: 'p' }, { kind: 'deny', feedback: 'Use other.txt' })).toEqual({ behavior: 'deny', message: 'Use other.txt' });
  });

  it("denies the call with the CLI's own rejection text when the user gives no feedback", () => {
    expect(promptResponse({ plan: 'p' }, { kind: 'deny', feedback: ' ' })).toEqual({ behavior: 'deny', message: CLI_REJECTION });
  });
});
