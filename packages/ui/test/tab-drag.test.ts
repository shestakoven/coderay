import { describe, expect, it } from 'vitest';
import { dropIndex, moveItem, reorderVisible, shiftFor } from '../src/project/tab-drag';

const SLOT = 40;

describe('dropIndex', () => {
  it('stays in place without movement', () => {
    expect(dropIndex(2, 0, SLOT, 5)).toBe(2);
  });

  it('moves by whole slots', () => {
    expect([dropIndex(1, 80, SLOT, 5), dropIndex(3, -80, SLOT, 5)]).toEqual([3, 1]);
  });

  it('moves once the pointer passes half a slot', () => {
    expect([dropIndex(1, 19, SLOT, 5), dropIndex(1, 20, SLOT, 5), dropIndex(1, 59, SLOT, 5), dropIndex(1, 60, SLOT, 5)]).toEqual([1, 2, 2, 3]);
  });

  it('moves left once the pointer passes half a slot to the left', () => {
    expect([dropIndex(3, -19, SLOT, 5), dropIndex(3, -21, SLOT, 5), dropIndex(3, -61, SLOT, 5)]).toEqual([3, 2, 1]);
  });

  it('clamps to the first tab', () => {
    expect([dropIndex(1, -1000, SLOT, 5), dropIndex(0, -41, SLOT, 5)]).toEqual([0, 0]);
  });

  it('clamps to the last tab', () => {
    expect([dropIndex(3, 1000, SLOT, 5), dropIndex(3, 40, SLOT, 5), dropIndex(3, 80, SLOT, 5)]).toEqual([4, 4, 4]);
  });

  it('respects the slot width', () => {
    expect([dropIndex(0, 100, 100, 5), dropIndex(0, 100, 50, 5)]).toEqual([1, 2]);
  });
});

describe('shiftFor', () => {
  const shifts = (from: number, to: number) => [0, 1, 2, 3, 4].map((index) => shiftFor(index, from, to, SLOT));

  it('slides the tabs between the old and the new place left when dragging right', () => {
    expect(shifts(1, 3)).toEqual([0, 0, -SLOT, -SLOT, 0]);
  });

  it('slides the tabs between the new and the old place right when dragging left', () => {
    expect(shifts(3, 1)).toEqual([0, SLOT, SLOT, 0, 0]);
  });

  it('slides nothing when the tab is back at its place', () => {
    expect(shifts(2, 2)).toEqual([0, 0, 0, 0, 0]);
  });

  it('handles a drag across the whole bar', () => {
    expect([shifts(0, 4), shifts(4, 0)]).toEqual([[0, -SLOT, -SLOT, -SLOT, -SLOT], [SLOT, SLOT, SLOT, SLOT, 0]]);
  });

  it('uses the slot width as the distance', () => {
    expect(shiftFor(2, 1, 2, 77)).toBe(-77);
  });
});

describe('moveItem', () => {
  const items = ['a', 'b', 'c', 'd'];

  it('moves an item right', () => {
    expect(moveItem(items, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an item left', () => {
    expect(moveItem(items, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('moves an item to the end', () => {
    expect(moveItem(items, 1, 3)).toEqual(['a', 'c', 'd', 'b']);
  });

  it('keeps the order when the item stays', () => {
    expect(moveItem(items, 2, 2)).toEqual(items);
  });

  it('returns a new array and leaves the input untouched', () => {
    const input = [...items];
    const moved = moveItem(input, 0, 3);
    expect(moved).not.toBe(input);
    expect(input).toEqual(['a', 'b', 'c', 'd']);
  });

  it.each([-1, 4, 10])('returns the input itself for an invalid from %d', (from) => {
    const input = [...items];
    expect(moveItem(input, from, 1)).toBe(input);
    expect(input).toEqual(items);
  });
});

describe('reorderVisible', () => {
  // b, d and e sit in the overflow menu; a, c and f are in the bar.
  const all = ['a', 'b', 'c', 'd', 'e', 'f'];
  const visible = ['a', 'c', 'f'];

  it('moves a visible tab right through the slots of the visible tabs', () => {
    expect(reorderVisible(all, visible, 0, 2)).toEqual(['c', 'b', 'f', 'd', 'e', 'a']);
  });

  it('moves a visible tab left through the slots of the visible tabs', () => {
    expect(reorderVisible(all, visible, 2, 0)).toEqual(['f', 'b', 'a', 'd', 'e', 'c']);
  });

  it('swaps neighbours in the bar without touching the hidden tab between them', () => {
    expect(reorderVisible(all, visible, 0, 1)).toEqual(['c', 'b', 'a', 'd', 'e', 'f']);
  });

  it('keeps the order when the tab is dropped where it was', () => {
    expect(reorderVisible(all, visible, 1, 1)).toEqual(all);
  });

  it('behaves like a plain move when every tab is visible', () => {
    expect(reorderVisible(all, all, 1, 4)).toEqual(moveItem(all, 1, 4));
    expect(reorderVisible(all, all, 1, 4)).toEqual(['a', 'c', 'd', 'e', 'b', 'f']);
  });

  it('leaves the inputs untouched', () => {
    const allCopy = [...all];
    const visibleCopy = [...visible];
    reorderVisible(allCopy, visibleCopy, 0, 2);
    expect([allCopy, visibleCopy]).toEqual([all, visible]);
  });
});
