import { useEffect, useState } from 'react';
import type { UsageView } from '@ide/protocol';
import { usageMeters } from './usage';

const TICK_MS = 60_000;

export function UsageMeter({ usage }: { usage: UsageView }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const meters = usageMeters(usage, now);
  if (meters.length === 0) return null;
  return (
    <span className="usage-meters" aria-label="Context and limits">
      {meters.map((meter) => (
        <span key={meter.text.split(' ')[0]} className={`usage-meter ${meter.level}`} title={meter.title}>
          {meter.fraction !== null && <i className="usage-bar" style={{ ['--fill' as string]: `${Math.round(meter.fraction * 100)}%` }} />}
          {meter.text}
        </span>
      ))}
    </span>
  );
}
