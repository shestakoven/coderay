// Stands in for React's useState and useEffect where there is no DOM to render into: a hook or a component runs against it and shows what it returned.
type Setter<S> = (next: S | ((previous: S) => S)) => void;

interface Slot {
  value?: unknown;
  deps?: readonly unknown[];
  cleanup?: void | (() => void);
}

interface Fiber {
  slots: Slot[];
  cursor: number;
  effects: (() => void)[];
  mounted: boolean;
  lateUpdates: number;
  rerender: () => void;
}

let current: Fiber | null = null;

const active = (): Fiber => {
  if (!current) throw new Error('a hook ran outside mount()');
  return current;
};

export function useState<S>(initial: S | (() => S)): [S, Setter<S>] {
  const fiber = active();
  const slot = (fiber.slots[fiber.cursor++] ??= { value: typeof initial === 'function' ? (initial as () => S)() : initial });
  const set: Setter<S> = (next) => {
    if (!fiber.mounted) {
      fiber.lateUpdates += 1;
      return;
    }
    const value = typeof next === 'function' ? (next as (previous: S) => S)(slot.value as S) : next;
    if (Object.is(value, slot.value)) return;
    slot.value = value;
    fiber.rerender();
  };
  return [slot.value as S, set];
}

export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void {
  const fiber = active();
  const index = fiber.cursor++;
  const previous = fiber.slots[index];
  if (previous?.deps && deps && deps.every((dep, i) => Object.is(dep, previous.deps?.[i]))) return;
  fiber.effects.push(() => {
    if (typeof previous?.cleanup === 'function') previous.cleanup();
    fiber.slots[index] = { deps, cleanup: effect() };
  });
}

export function mount<T>(render: () => T) {
  const fiber: Fiber = { slots: [], cursor: 0, effects: [], mounted: true, lateUpdates: 0, rerender: () => undefined };
  let output: T;
  let rendering = false;
  let dirty = false;
  const run = () => {
    if (rendering) {
      dirty = true;
      return;
    }
    rendering = true;
    try {
      do {
        dirty = false;
        fiber.cursor = 0;
        current = fiber;
        output = render();
        current = null;
        for (const effect of fiber.effects.splice(0)) effect();
      } while (dirty);
    } finally {
      current = null;
      rendering = false;
    }
  };
  fiber.rerender = run;
  run();
  return {
    get output() {
      return output;
    },
    get lateUpdates() {
      return fiber.lateUpdates;
    },
    /** Renders again, as React does when the parent passes new props. */
    rerender: run,
    unmount() {
      fiber.mounted = false;
      for (const slot of fiber.slots) if (typeof slot?.cleanup === 'function') slot.cleanup();
    },
  };
}
