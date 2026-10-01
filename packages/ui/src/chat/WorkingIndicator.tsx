import { useEffect, useState } from 'react';
import { elapsedLabel, type Working } from './working';

export function WorkingIndicator({ working }: { working: Working }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="working" role="status" aria-live="polite">
      <span className="working-dots" aria-hidden="true"><i /><i /><i /></span>
      <span className="working-label">{working.label}</span>
      <span className="working-time">{elapsedLabel(working.since, now)}</span>
    </div>
  );
}
