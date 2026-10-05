export const TAB = { full: 126, compact: 38, active: 150, overflow: 56, gap: 2 } as const;

export interface TabFit {
  mode: 'full' | 'compact' | 'overflow';
  // Indexes of tabs that stay in the bar; the rest go to the overflow menu.
  visible: number[];
  hidden: number[];
}

// Tabs shrink to their minimum first, then collapse to a letter, then spill into a menu. The shown tab never leaves the bar.
export function fitTabs(count: number, activeIndex: number, available: number): TabFit {
  const all = Array.from({ length: count }, (_, index) => index);
  if (count * (TAB.full + TAB.gap) - TAB.gap <= available) return { mode: 'full', visible: all, hidden: [] };
  if (TAB.active + (count - 1) * (TAB.compact + TAB.gap) <= available) return { mode: 'compact', visible: all, hidden: [] };
  const room = Math.max(0, Math.floor((available - TAB.overflow - TAB.active - TAB.gap) / (TAB.compact + TAB.gap)));
  const others = all.filter((index) => index !== activeIndex);
  const kept = new Set(others.slice(0, room));
  const visible = all.filter((index) => index === activeIndex || kept.has(index));
  return { mode: 'overflow', visible, hidden: all.filter((index) => !visible.includes(index)) };
}
