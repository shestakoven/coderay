import type { ReactNode } from 'react';
import { Icon } from './Icon';

// The bar names where you are and nothing else: projects on the left, the branch and settings at the right.
export function TopBar({ tabs, reviewCount, onSettings, mac, branchSlot }: { tabs: ReactNode; reviewCount: number; onSettings: () => void; mac: boolean; branchSlot: (element: HTMLElement | null) => void }) {
  return (
    <header className="topbar pbar">
      {tabs}
      <div className="pbar-branch" ref={branchSlot} />
      <button className="pbar-gear" onClick={onSettings} aria-label="Settings (⌘,)" data-tip="Settings" data-keys={`${mac ? '⌘' : 'Ctrl'} ,`}>
        <Icon name="settings" size={18} />
        {reviewCount > 0 && <b>{reviewCount}</b>}
      </button>
    </header>
  );
}
