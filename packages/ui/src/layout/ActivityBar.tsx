import { Icon } from './Icon';

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
      <button className={left ? 'on' : ''} onClick={() => onToggle('left')} title="Project panel" aria-pressed={left}><Icon name="panel-left" size={20} /></button>
      <button className={right ? 'on' : ''} onClick={() => onToggle('right')} title="Agent and details" aria-pressed={right}><Icon name="panel-right" size={20} /></button>
      <button className={bottom ? 'on' : ''} onClick={() => onToggle('bottom')} title="Timeline" aria-pressed={bottom}><Icon name="panel-bottom" size={20} /></button>
      <button className={focus ? 'on' : ''} onClick={onFocus} title="Focus: map only (F)" aria-pressed={focus}><Icon name="maximize" size={20} /></button>
      <span className="activity-gap" />
      <button onClick={onOpenProject} title="Open project…"><Icon name="folder" size={20} /></button>
      <button onClick={onSettings} title="Settings" className="with-badge">
        <Icon name="settings" size={20} />
        {badge > 0 && <b>{badge}</b>}
      </button>
    </nav>
  );
}
