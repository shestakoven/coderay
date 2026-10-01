import { useEffect, useRef, useState } from 'react';
import type { MapProgress, MapStatus } from '@ide/protocol';
import { elapsedText, mapActivities, type ActivityKey } from './activity';

export function MapActivity({ progress, status }: { progress: MapProgress; status: MapStatus | null }) {
  const activities = mapActivities(progress, status);
  const started = useRef(new Map<ActivityKey, number>());
  const [now, setNow] = useState(Date.now());
  const active = activities.length > 0;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const keys = new Set(activities.map((activity) => activity.key));
  for (const key of started.current.keys()) if (!keys.has(key)) started.current.delete(key);
  for (const key of keys) if (!started.current.has(key)) started.current.set(key, Date.now());
  if (!active) return null;
  return (
    <div className="map-activity" role="status" aria-live="polite">
      {activities.map((activity) => (
        <div key={activity.key} className="map-activity-row">
          <div className="map-activity-head">
            <span className="map-activity-label">{activity.label}</span>
            <span className="map-activity-time">{elapsedText(started.current.get(activity.key) ?? now, now)}</span>
          </div>
          <div className={`progress${activity.fraction === null ? ' indeterminate' : ''}`} role="progressbar" aria-label={activity.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={activity.fraction === null ? undefined : Math.round(activity.fraction * 100)}>
            <i style={activity.fraction === null ? undefined : { width: `${Math.round(activity.fraction * 100)}%` }} />
          </div>
          {activity.detail && <div className="map-activity-detail">{activity.detail}</div>}
        </div>
      ))}
    </div>
  );
}
