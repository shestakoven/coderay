import { badgeText, type StepMark } from './plan-state';

export function StepBadges({ steps, compact = false }: { steps: StepMark[]; compact?: boolean }) {
  if (steps.length === 0) return null;
  return (
    <span className={`step-badges${compact ? ' compact' : ''}`}>
      {steps.map((step) => (
        <span key={step.n} className={`step-badge ${step.status}`} title={`Step ${step.n}: ${step.status}`}>
          {badgeText(step)}
        </span>
      ))}
    </span>
  );
}
