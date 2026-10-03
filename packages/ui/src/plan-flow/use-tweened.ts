import { useEffect, useRef, useState } from 'react';
import type { Positions } from './flow-layout';
import { tweenPositions } from './tween';

export function useTweened(target: Positions | null, ms = 480): Positions | null {
  const [value, setValue] = useState<Positions | null>(target);
  const current = useRef<Positions | null>(target);
  useEffect(() => {
    if (target === null) {
      current.current = null;
      setValue(null);
      return;
    }
    const from = current.current;
    if (from === null) {
      current.current = target;
      setValue(target);
      return;
    }
    if (from === target) return;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const next = tweenPositions(from, target, t);
      current.current = next;
      setValue(next);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return value;
}
