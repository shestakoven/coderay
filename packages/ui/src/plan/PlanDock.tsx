import { useState } from 'react';
import type { MapSnapshot, PlanAnswer, PlanView } from '@ide/protocol';
import { PlanPanel } from './PlanPanel';

export function PlanDock({ plan, snapshot, onAnswer, onFocusStep }: {
  plan: PlanView;
  snapshot: MapSnapshot | null;
  onAnswer: (answer: PlanAnswer) => void;
  onFocusStep: (index: number) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="plan-dock">
      <PlanPanel plan={plan} snapshot={snapshot} open={open} onToggle={() => setOpen(!open)} onAnswer={onAnswer} onFocusStep={onFocusStep} />
    </div>
  );
}
