import type { ReactNode } from 'react';
import type { LeftTab } from './panel-state';

const TABS: { key: LeftTab; label: string }[] = [
  { key: 'plan', label: 'Plan' },
  { key: 'components', label: 'Components' },
  { key: 'files', label: 'Files' },
];

export function LeftPanel({ tab, onTab, plan, components, files, hasPlan }: {
  tab: LeftTab;
  onTab: (tab: LeftTab) => void;
  plan: ReactNode;
  components: ReactNode;
  files: ReactNode;
  hasPlan: boolean;
}) {
  return (
    <aside className="left-panel" aria-label="Project panel">
      <div className="seg" role="tablist">
        {TABS.map(({ key, label }) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''} onClick={() => onTab(key)}>
            {label}
            {key === 'plan' && hasPlan && <span className="seg-dot" aria-label="has a plan" />}
          </button>
        ))}
      </div>
      <div className="left-body">
        <div hidden={tab !== 'plan'}>{hasPlan ? plan : <div className="empty muted">No plan yet. When the agent proposes one, it appears here and on the map.</div>}</div>
        <div hidden={tab !== 'components'} className="left-pane">{components}</div>
        <div hidden={tab !== 'files'} className="left-pane">{files}</div>
      </div>
    </aside>
  );
}
