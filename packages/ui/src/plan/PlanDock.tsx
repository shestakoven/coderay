import { useState } from 'react';
import type { MapSnapshot, PlanAnswer, PlanView } from '@ide/protocol';
import { PlanPanel } from './PlanPanel';

export function PlanDock({ plan, snapshot, working, onAnswer, onFocusStep, onHoverStep }: {
  plan: PlanView;
  snapshot: MapSnapshot | null;
  working: boolean;
  onAnswer: (answer: PlanAnswer) => void;
  onFocusStep: (index: number) => void;
  onHoverStep?: (key: string | null) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="plan-dock">
      <PlanPanel plan={plan} snapshot={snapshot} open={open} working={working} onToggle={() => setOpen(!open)} onAnswer={onAnswer} onFocusStep={onFocusStep} onHoverStep={onHoverStep} />
    </div>
  );
}
