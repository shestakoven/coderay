import { describe, expect, it } from 'vitest';
import { Hold } from '../../src/gate/hold';

const settled = (promise: Promise<unknown>) => {
  const state = { done: false };
  void promise.then(() => (state.done = true));
  return state;
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('Hold', () => {
  it('lets a wait on a free hold through at once', async () => {
    expect(await new Hold().wait(new AbortController().signal, 1000)).toBe('released');
  });

  it('keeps every waiter until release, then frees all of them in arrival order', async () => {
    const hold = new Hold();
    hold.hold('a watchdog event');
    const order: number[] = [];
    const waits = [1, 2, 3].map((n) => hold.wait(new AbortController().signal, 5000).then((r) => (order.push(n), r)));
    const state = settled(waits[0]!);
    await tick();
    expect([hold.isHeld(), hold.reason(), state.done]).toEqual([true, 'a watchdog event', false]);
    hold.release();
    expect(await Promise.all(waits)).toEqual(['released', 'released', 'released']);
    expect([order, hold.isHeld(), hold.reason()]).toEqual([[1, 2, 3], false, null]);
  });

  it('answers timeout at the deadline and leaves no waiter behind', async () => {
    const hold = new Hold();
    hold.hold('x');
    expect(await hold.wait(new AbortController().signal, 20)).toBe('timeout');
    hold.release();
  });

  it('answers aborted when the signal fires, also when it already fired', async () => {
    const hold = new Hold();
    hold.hold('x');
    const controller = new AbortController();
    const wait = hold.wait(controller.signal, 5000);
    controller.abort();
    expect(await wait).toBe('aborted');
    expect(await hold.wait(controller.signal, 5000)).toBe('aborted');
  });

  it('releases twice, and when it was never held, harmlessly', async () => {
    const hold = new Hold();
    hold.release();
    hold.hold('x');
    hold.release();
    hold.release();
    expect(hold.isHeld()).toBe(false);
    expect(await hold.wait(new AbortController().signal, 1000)).toBe('released');
  });

  it('tells its listeners about every change, and a listener that throws does not stop the others', () => {
    const hold = new Hold();
    const seen: boolean[] = [];
    hold.onChange(() => {
      throw new Error('boom');
    });
    const off = hold.onChange(() => seen.push(hold.isHeld()));
    hold.hold('x');
    hold.release();
    off();
    hold.hold('y');
    expect(seen).toEqual([true, false]);
  });
});
