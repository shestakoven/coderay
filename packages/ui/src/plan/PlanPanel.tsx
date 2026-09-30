import { useState } from 'react';
import type { MapSnapshot, PlanAnswer, PlanStepView, PlanView } from '@ide/protocol';
import { badgeText, classifyTargets, planTitle } from './plan-state';

const OP_MARK = { modify: '~', create: '+', delete: '−' } as const;
const STATUS_ICON = { pending: '○', active: '●', done: '✓' } as const;

export function PlanPanel({ plan, snapshot, open, onToggle, onAnswer, onFocusStep }: {
  plan: PlanView;
  snapshot: MapSnapshot | null;
  open: boolean;
  onToggle: () => void;
  onAnswer: (answer: PlanAnswer) => void;
  onFocusStep: (index: number) => void;
}) {
  const [changing, setChanging] = useState(false);
  const [feedback, setFeedback] = useState('');
  return (
    <div className={`plan-panel ${plan.status}`} data-testid="plan-panel">
      <button className="plan-panel-head" onClick={onToggle} aria-expanded={open}>
        <span className="plan-dot" />
        <b>{planTitle(plan)}</b>
        <span className="plan-toggle">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <>
          <div className="plan-goal">{plan.goal}</div>
          <ol className="plan-steps">
            {plan.steps.map((step, index) => (
              <StepRow key={step.key} step={step} n={index + 1} plan={plan} snapshot={snapshot} onFocus={() => onFocusStep(index)} />
            ))}
          </ol>
          <Note plan={plan} />
          {plan.status === 'proposed' && (
            <>
              {changing && (
                <textarea
                  className="plan-feedback"
                  rows={2}
                  autoFocus
                  placeholder="What should change? The agent gets this as the answer to propose_plan."
                  value={feedback}
                  onChange={(event) => setFeedback(event.target.value)}
                />
              )}
              <div className="prompt-actions">
                <button onClick={() => onAnswer({ kind: 'reject', feedback: changing ? feedback : '' })}>Reject</button>
                {changing ? (
                  <button
                    disabled={feedback.trim() === ''}
                    onClick={() => {
                      onAnswer({ kind: 'changes', feedback });
                      setChanging(false);
                      setFeedback('');
                    }}
                  >
                    Send changes
                  </button>
                ) : (
                  <button onClick={() => setChanging(true)}>Request changes</button>
                )}
                <button className="primary" onClick={() => onAnswer({ kind: 'approve' })}>Approve</button>
              </div>
            </>
          )}
          {plan.status === 'approved' && (
            <div className="prompt-actions">
              <button title="Revokes the approval. The agent is not interrupted; its next write is denied." onClick={() => onAnswer({ kind: 'reject', feedback: '' })}>
                Reject
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Note({ plan }: { plan: PlanView }) {
  const notes = plan.review.notes.join('; ');
  if (plan.status === 'proposed') return <div className="plan-note">Waits for you: {notes}.</div>;
  if (plan.status === 'approved' && plan.approvedBy === 'auto') {
    return <div className="plan-note muted">Approved automatically: {notes}. Reject revokes the approval; the agent is not interrupted, and its next write is denied.</div>;
  }
  if (plan.status === 'rejected') {
    return <div className="plan-note muted">Rejected{plan.feedback ? `: ${plan.feedback}` : ''}. Files it already changed stay as they are; the agent's next write is denied.</div>;
  }
  if (plan.status === 'withdrawn' || plan.status === 'changes-requested') return <div className="plan-note muted">{plan.feedback}</div>;
  return null;
}

function StepRow({ step, n, plan, snapshot, onFocus }: {
  step: PlanStepView;
  n: number;
  plan: PlanView;
  snapshot: MapSnapshot | null;
  onFocus: () => void;
}) {
  const component = (id: string) => snapshot?.components.find((candidate) => candidate.id === id);
  const groups = new Map<string, string[]>();
  const other: string[] = [];
  const add = (name: string, line: string) => groups.set(name, [...(groups.get(name) ?? []), line]);
  for (const target of classifyTargets(step, plan, snapshot)) {
    const op = OP_MARK[target.op];
    if (target.kind === 'component') {
      const found = component(target.componentId);
      add(found?.name ?? target.componentId, `${op} whole component (${found?.files.length ?? 0} files)`);
    } else if (target.kind === 'directory') add('Directories', `${op} ${target.path}/`);
    else if (target.kind === 'other') other.push(`${op} ${target.path}`);
    else add(component(target.owner)?.name ?? target.owner, `${op} ${target.path.slice(target.path.lastIndexOf('/') + 1)}`);
  }
  return (
    <li className={`plan-step ${step.status}`}>
      <button className="plan-step-head" onClick={onFocus} title="Show on the map">
        <span className={`step-badge ${step.status}`}>{badgeText({ n, status: step.status })}</span>
        <span className="plan-step-title">{step.title}</span>
        <span className="plan-step-status">{STATUS_ICON[step.status]}</span>
      </button>
      <div className="plan-targets">
        {[...groups].map(([name, lines]) => (
          <div key={name} className="plan-target-group">
            <span className="plan-component">{name}</span>
            {lines.map((line) => <code key={line}>{line}</code>)}
          </div>
        ))}
        {other.length > 0 && (
          <div className="plan-target-group">
            <span className="plan-component muted">Other files (not on the map)</span>
            {other.map((line) => <code key={line}>{line}</code>)}
          </div>
        )}
      </div>
      {step.rationale && (
        <details className="plan-rationale">
          <summary>Why</summary>
          {step.rationale}
        </details>
      )}
    </li>
  );
}
