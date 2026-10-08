import type { PlanFlow, PlanView } from '@ide/protocol';
import { Icon } from '../layout/Icon';
import { stepPhase } from './flow-model';

// The plan's steps beside the map, each with its reason. Hovering a step lights its parts on the map.
export function SteerRail({ plan, flow, open, onToggle, onHover }: {
  plan: PlanView;
  flow: PlanFlow;
  open: boolean;
  onToggle: () => void;
  onHover: (key: string | null) => void;
}) {
  const files = (key: string): number => new Set(flow.nodes.filter((node) => node.steps.includes(key) && node.state !== 'existing').flatMap((node) => node.files.map((file) => file.path))).size;
  return (
    <aside className={`pf-rail${open ? '' : ' closed'}`} data-testid="flow-rail">
      <button type="button" className="pf-rail-head" onClick={onToggle} aria-expanded={open} title={open ? 'Collapse the steps' : 'Show the steps'}>
        <span className="pf-rail-title">Plan <em>v{plan.version}</em></span>
        <span className="pf-rail-count">{plan.steps.length} step{plan.steps.length === 1 ? '' : 's'}</span>
        <span className="pf-rail-chev"><Icon name={open ? 'panel-left' : 'panel-right'} size={14} /></span>
      </button>
      {open && (
        <>
          <p className="pf-rail-goal">{plan.goal}</p>
          <ol className="pf-steps" onMouseLeave={() => onHover(null)}>
            {plan.steps.map((step, index) => {
              const phase = stepPhase(plan, step.key);
              const count = files(step.key);
              return (
                <li key={step.key} className="pf-step" onMouseEnter={() => onHover(step.key)} data-testid={`flow-step-${index + 1}`}>
                  <span className={`step-badge ${phase === 'proposed' ? '' : phase}`}>{phase === 'done' ? '✓' : index + 1}</span>
                  <span className="pf-step-body">
                    <span className="pf-step-title">{step.title}</span>
                    {step.rationale && <span className="pf-step-why">{step.rationale}</span>}
                    <span className="pf-step-meta">{count === 0 ? 'no files' : `${count} file${count === 1 ? '' : 's'}`}</span>
                  </span>
                </li>
              );
            })}
          </ol>
          <div className="pf-rail-legend">
            <span><i className="lg existing" />existing</span>
            <span><i className="lg modify" />modified</span>
            <span><i className="lg create" />new</span>
            <span><i className="lg delete" />removed</span>
          </div>
        </>
      )}
    </aside>
  );
}
