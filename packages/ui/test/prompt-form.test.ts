import { describe, expect, it } from 'vitest';
import type { AskQuestion } from '@ide/protocol';
import { askAnswers } from '../src/chat/prompt-form';

const single: AskQuestion = { question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'red', description: '' }, { label: 'blue', description: '' }] };
const multi: AskQuestion = { question: 'Which sizes?', header: 'Sizes', multiSelect: true, options: [{ label: 'S', description: '' }, { label: 'L', description: '' }] };

describe('askAnswers', () => {
  it('answers a single-choice question with the chosen label', () => {
    expect(askAnswers([single], [{ chosen: ['blue'], other: '' }])).toEqual({ answers: { 'Which color?': 'blue' } });
  });

  it('joins the labels chosen for a multi-select question with ", "', () => {
    expect(askAnswers([multi], [{ chosen: ['S', 'L'], other: '' }])).toEqual({ answers: { 'Which sizes?': 'S, L' } });
  });

  it('answers with the text typed as another answer', () => {
    expect(askAnswers([single], [{ chosen: ['red'], other: 'green' }])).toEqual({ answers: { 'Which color?': 'green' } });
  });

  it('asks for an answer to every question', () => {
    expect(askAnswers([single, multi], [{ chosen: ['red'], other: '' }, { chosen: [], other: ' ' }])).toEqual({ error: 'Answer "Which sizes?" first.' });
  });
});
