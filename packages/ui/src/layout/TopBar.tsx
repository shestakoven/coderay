import type { ReactNode } from 'react';
import { Icon } from './Icon';

// The bar names where you are and nothing else: projects on the left, settings at the right.
export function TopBar({ tabs, reviewCount, onSettings, mac }: { tabs: ReactNode; reviewCount: number; onSettings: () => void; mac: boolean }) {
  return (
    <header className="topbar pbar">
      {tabs}
      <button className="pbar-gear" onClick={onSettings} aria-label="Settings (⌘,)" data-tip="Settings" data-keys={`${mac ? '⌘' : 'Ctrl'} ,`}>
        <Icon name="settings" size={18} />
        {reviewCount > 0 && <b>{reviewCount}</b>}
      </button>
    </header>
  );
}
