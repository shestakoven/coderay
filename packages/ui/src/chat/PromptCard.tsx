import { useState } from 'react';
import type { AskQuestion, PromptAnswer, PromptItem } from '@ide/protocol';
import { askAnswers, type AskSelection } from './prompt-form';

export function PromptCard({ item, onAnswer }: { item: PromptItem; onAnswer: (answer: PromptAnswer) => void }) {
  if (item.status !== 'pending') return <div className="prompt done">{summary(item)}</div>;
  switch (item.body.tool) {
    case 'AskUserQuestion':
      return <AskForm questions={item.body.questions} onAnswer={onAnswer} />;
    case 'ExitPlanMode':
      return <PlanForm plan={item.body.plan} onAnswer={onAnswer} />;
  }
}

function AskForm({ questions, onAnswer }: { questions: AskQuestion[]; onAnswer: (answer: PromptAnswer) => void }) {
  const [selections, setSelections] = useState<AskSelection[]>(questions.map(() => ({ chosen: [], other: '' })));
  const [error, setError] = useState<string | null>(null);
  const update = (index: number, change: Partial<AskSelection>) =>
    setSelections(selections.map((selection, at) => (at === index ? { ...selection, ...change } : selection)));
  const toggle = (index: number, question: AskQuestion, label: string) => {
    const chosen = selections[index]?.chosen ?? [];
    if (!question.multiSelect) update(index, { chosen: [label] });
    else update(index, { chosen: chosen.includes(label) ? chosen.filter((item) => item !== label) : [...chosen, label] });
  };
  const submit = () => {
    const result = askAnswers(questions, selections);
    if ('error' in result) setError(result.error);
    else onAnswer({ kind: 'answers', answers: result.answers });
  };
  return (
    <div className="prompt">
      {questions.map((question, index) => (
        <fieldset key={question.question}>
          <legend>
            {question.header && <span className="chip">{question.header}</span>} {question.question}
          </legend>
          {question.options.map((option) => (
            <label key={option.label} className="option">
              <input
                type={question.multiSelect ? 'checkbox' : 'radio'}
                checked={selections[index]?.chosen.includes(option.label) ?? false}
                onChange={() => toggle(index, question, option.label)}
              />
              {option.label}
              {option.description && <span className="muted"> — {option.description}</span>}
            </label>
          ))}
          <input
            className="other"
            placeholder="Other answer"
            value={selections[index]?.other ?? ''}
            onChange={(event) => update(index, { other: event.target.value })}
          />
        </fieldset>
      ))}
      {error && <div className="problem">{error}</div>}
      <div className="prompt-actions">
        <button onClick={() => onAnswer({ kind: 'deny', feedback: '' })}>Decline</button>
        <button onClick={submit}>Answer</button>
      </div>
    </div>
  );
}

function PlanForm({ plan, onAnswer }: { plan: string; onAnswer: (answer: PromptAnswer) => void }) {
  return (
    <div className="prompt">
      <div className="muted">The agent proposes this plan:</div>
      <pre className="plan">{plan}</pre>
      <div className="muted">To change it, press Keep planning and say what to change in the chat.</div>
      <div className="prompt-actions">
        <button onClick={() => onAnswer({ kind: 'deny', feedback: '' })}>Keep planning</button>
        <button onClick={() => onAnswer({ kind: 'allow' })}>Approve</button>
      </div>
    </div>
  );
}

function summary(item: PromptItem): string {
  if (item.status === 'dropped') return `${item.body.tool}: no longer waiting for an answer.`;
  const answer = item.answer;
  if (answer?.kind === 'answers') return `Answered: ${Object.values(answer.answers).join('; ')}`;
  if (answer?.kind === 'deny') return item.body.tool === 'ExitPlanMode' ? 'Plan not approved yet.' : 'Declined.';
  return item.body.tool === 'ExitPlanMode' ? 'Plan approved.' : 'Allowed.';
}
