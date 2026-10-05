// Where the dragged tab would land when it has moved `dx` pixels from its slot.
export function dropIndex(from: number, dx: number, slot: number, count: number): number {
  return Math.max(0, Math.min(count - 1, from + Math.round(dx / slot)));
}

// How far a tab that is not being dragged slides to make room.
export function shiftFor(index: number, from: number, to: number, slot: number): number {
  if (from < to && index > from && index <= to) return -slot;
  if (from > to && index < from && index >= to) return slot;
  return 0;
}

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return items;
  next.splice(to, 0, moved);
  return next;
}

// Tabs in the overflow menu keep their slots: only the visible ones trade places.
export function reorderVisible(all: string[], visible: string[], from: number, to: number): string[] {
  const reordered = moveItem(visible, from, to);
  let next = 0;
  return all.map((id) => (visible.includes(id) ? reordered[next++]! : id));
}
