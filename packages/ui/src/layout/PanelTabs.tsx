export interface PanelTab<T extends string> {
  key: T;
  label: string;
  dot?: boolean;
  count?: number;
}

export function PanelTabs<T extends string>({ label, tabs, value, onChange }: { label: string; tabs: PanelTab<T>[]; value: T; onChange: (key: T) => void }) {
  return (
    <div className="ptabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button key={tab.key} role="tab" aria-selected={value === tab.key} className={value === tab.key ? 'on' : ''} onClick={() => onChange(tab.key)}>
          {tab.label}
          {tab.dot && <span className="seg-dot" aria-label="has a plan" />}
          {tab.count !== undefined && tab.count > 0 && <span className="tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}
