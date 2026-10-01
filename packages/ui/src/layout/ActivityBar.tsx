export function ActivityBar({ left, right, bottom, focus, onToggle, onFocus, onSettings, onOpenProject, badge }: {
  left: boolean;
  right: boolean;
  bottom: boolean;
  focus: boolean;
  onToggle: (panel: 'left' | 'right' | 'bottom') => void;
  onFocus: () => void;
  onSettings: () => void;
  onOpenProject: () => void;
  badge: number;
}) {
  return (
    <nav className="activity" aria-label="Layout">
      <button className={left ? 'on' : ''} onClick={() => onToggle('left')} title="Project panel" aria-pressed={left}>◧</button>
      <button className={right ? 'on' : ''} onClick={() => onToggle('right')} title="Agent and details" aria-pressed={right}>◨</button>
      <button className={bottom ? 'on' : ''} onClick={() => onToggle('bottom')} title="Timeline" aria-pressed={bottom}>▭</button>
      <button className={focus ? 'on' : ''} onClick={onFocus} title="Focus: map only (F)" aria-pressed={focus}>⛶</button>
      <span className="activity-gap" />
      <button onClick={onOpenProject} title="Open project…">⌂</button>
      <button onClick={onSettings} title="Settings" className="with-badge">
        ⚙
        {badge > 0 && <b>{badge}</b>}
      </button>
    </nav>
  );
}
