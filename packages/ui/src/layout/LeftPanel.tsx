import type { ReactNode } from 'react';
import { PanelTabs } from './PanelTabs';
import type { LeftTab } from './panel-state';

export const LEFT_TABS: { key: LeftTab; label: string }[] = [
  { key: 'components', label: 'Components' },
  { key: 'files', label: 'Files' },
  { key: 'details', label: 'Details' },
];

export function LeftPanel({ hidden, tab, onTab, components, files, detailsRef }: {
  hidden: boolean;
  tab: LeftTab;
  onTab: (tab: LeftTab) => void;
  components: ReactNode;
  files: ReactNode;
  detailsRef: (element: HTMLElement | null) => void;
}) {
  return (
    <aside className="left-panel" aria-label="Project panel" hidden={hidden}>
      <PanelTabs label="Project panel" tabs={LEFT_TABS} value={tab} onChange={onTab} />
      <div className="left-body">
        <div hidden={tab !== 'components'} className="left-pane">{components}</div>
        <div hidden={tab !== 'files'} className="left-pane">{files}</div>
        <div hidden={tab !== 'details'} className="left-pane details-slot" ref={detailsRef}>
          <div className="empty muted">Select a component or file on the map to see its details and changes.</div>
        </div>
      </div>
    </aside>
  );
}
