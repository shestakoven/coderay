import { describe, expect, it } from 'vitest';
import { fitTabs, TAB } from '../src/project/tabs-fit';

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
// Width of all tabs at full size, and with only the shown tab wide.
const fullWidth = (count: number) => count * (TAB.full + TAB.gap) - TAB.gap;
const compactWidth = (count: number) => TAB.active + (count - 1) * (TAB.compact + TAB.gap);
// Smallest width that keeps `room` other tabs next to the shown one and the overflow button.
const overflowWidth = (room: number) => TAB.overflow + TAB.active + TAB.gap + room * (TAB.compact + TAB.gap);

describe('TAB', () => {
  it('has the agreed tab widths', () => {
    expect(TAB).toEqual({ full: 126, compact: 38, active: 150, overflow: 56, gap: 2 });
  });
});

describe('fitTabs full', () => {
  it('shows every tab at full size when they fit exactly', () => {
    expect(fullWidth(3)).toBe(382);
    expect(fitTabs(3, 1, 382)).toEqual({ mode: 'full', visible: [0, 1, 2], hidden: [] });
  });

  it('leaves full size one pixel short', () => {
    expect(fitTabs(3, 1, 381)).toEqual({ mode: 'compact', visible: [0, 1, 2], hidden: [] });
  });

  it('stays full with plenty of room', () => {
    expect(fitTabs(5, 4, 10_000)).toEqual({ mode: 'full', visible: [0, 1, 2, 3, 4], hidden: [] });
  });
});

describe('fitTabs compact', () => {
  it('keeps every tab visible, only the shown one wide, when they fit exactly', () => {
    expect(compactWidth(3)).toBe(230);
    expect(fitTabs(3, 0, 230)).toEqual({ mode: 'compact', visible: [0, 1, 2], hidden: [] });
  });

  it('overflows one pixel short of compact', () => {
    expect(fitTabs(3, 0, 229).mode).toBe('overflow');
  });

  it('uses the compact boundary for the tab count', () => {
    expect(compactWidth(10)).toBe(510);
    expect([fitTabs(10, 3, 510).mode, fitTabs(10, 3, 509).mode]).toEqual(['compact', 'overflow']);
  });
});

describe('fitTabs overflow', () => {
  it('keeps the first tabs that fit next to the shown one', () => {
    expect(overflowWidth(2)).toBe(288);
    expect(fitTabs(10, 0, 288)).toEqual({ mode: 'overflow', visible: [0, 1, 2], hidden: range(3, 10) });
  });

  it('keeps one tab fewer one pixel short', () => {
    expect(fitTabs(10, 0, 287)).toEqual({ mode: 'overflow', visible: [0, 1], hidden: range(2, 10) });
  });

  it('keeps the shown tab in the middle and the first others in order', () => {
    expect(fitTabs(10, 5, 288)).toEqual({ mode: 'overflow', visible: [0, 1, 5], hidden: [2, 3, 4, 6, 7, 8, 9] });
  });

  it('keeps the shown tab when it is the last one', () => {
    expect(fitTabs(10, 9, 288)).toEqual({ mode: 'overflow', visible: [0, 1, 9], hidden: range(2, 9) });
  });

  it('keeps the most other tabs just below the compact width', () => {
    expect(fitTabs(10, 4, 509)).toEqual({ mode: 'overflow', visible: range(0, 8), hidden: [8, 9] });
  });

  it('keeps one other tab at the exact width for one, none a pixel short', () => {
    expect(overflowWidth(1)).toBe(248);
    expect(fitTabs(10, 6, 248).visible).toEqual([0, 6]);
    expect(fitTabs(10, 6, 247).visible).toEqual([6]);
  });

  it.each([0, 100, -50])('shows only the shown tab with no room at width %d', (available) => {
    expect(fitTabs(6, 3, available)).toEqual({ mode: 'overflow', visible: [3], hidden: [0, 1, 2, 4, 5] });
  });

  it('handles a huge number of tabs', () => {
    const fit = fitTabs(1000, 500, 1000);
    expect(fit.mode).toBe('overflow');
    expect(fit.visible).toEqual([...range(0, 19), 500]);
    expect(fit.hidden).toHaveLength(980);
    expect(fit.hidden).not.toContain(500);
  });
});

describe('fitTabs single tab', () => {
  it('shows a lone tab at full size when it fits', () => {
    expect(fitTabs(1, 0, 126)).toEqual({ mode: 'full', visible: [0], hidden: [] });
  });

  it.each([125, 40, 0])('still shows a lone tab at width %d', (available) => {
    expect(fitTabs(1, 0, available)).toEqual({ mode: 'overflow', visible: [0], hidden: [] });
  });
});

describe('fitTabs partition', () => {
  const counts = [1, 2, 3, 7, 25];
  const widths = [0, 120, 200, 260, 300, 400, 600, 900, 4000];
  const cases = counts.flatMap((count) => widths.flatMap((available) => [0, Math.floor(count / 2), count - 1].map((active) => [count, active, available])));

  it.each(cases)('count %d, shown %d, width %d: visible and hidden split every tab, shown one visible', (count, active, available) => {
    const { visible, hidden } = fitTabs(count, active, available);
    const ascending = (list: number[]) => list.every((value, i) => i === 0 || list[i - 1]! < value);
    expect(ascending(visible)).toBe(true);
    expect(ascending(hidden)).toBe(true);
    expect([...visible, ...hidden].sort((a, b) => a - b)).toEqual(range(0, count));
    expect(visible).toContain(active);
  });

  it('never shows fewer tabs with more room', () => {
    for (const active of [0, 6, 11]) {
      let shown = 0;
      for (let available = 0; available <= 1600; available += 1) {
        const now = fitTabs(12, active, available).visible.length;
        expect(now, `width ${available}`).toBeGreaterThanOrEqual(shown);
        shown = now;
      }
    }
  });
});
