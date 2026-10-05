import type { ReactNode } from 'react';
import { PanelTabs } from './PanelTabs';
import type { RightTab } from './panel-state';

export function RightPanel({ hidden, tab, onTab, hasPlan, reviewCount, agent, plan, review }: {
  hidden: boolean;
  tab: RightTab;
  onTab: (tab: RightTab) => void;
  hasPlan: boolean;
  reviewCount: number;
  agent: ReactNode;
  plan: ReactNode;
  review: ReactNode;
}) {
  return (
    <aside className="right-panel" hidden={hidden} aria-label="Agent and details">
      <PanelTabs
        label="Agent and details"
        tabs={[{ key: 'agent', label: 'Agent' }, { key: 'plan', label: 'Plan', dot: hasPlan }, { key: 'review', label: 'Review', count: reviewCount }]}
        value={tab}
        onChange={onTab}
      />
      <div className="right-body" hidden={tab !== 'agent'}>{agent}</div>
      <div className="right-body" hidden={tab !== 'plan'}>{plan}</div>
      <div className="right-body" hidden={tab !== 'review'}>{review}</div>
    </aside>
  );
}
