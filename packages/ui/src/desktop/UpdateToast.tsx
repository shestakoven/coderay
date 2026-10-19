import { useEffect, useState } from 'react';
import { Icon } from '../layout/Icon';
import { updateToastVisible } from './update-state';
import { useDesktopUpdate } from './use-desktop-update';

// A restart that has not happened by then did not start; the button comes back.
const RESTART_GIVE_UP_MS = 10_000;

export function UpdateToast() {
  const { state, restart } = useDesktopUpdate();
  const [dismissedOffer, setDismissedOffer] = useState<number | null>(null);
  const [restartingVersion, setRestartingVersion] = useState<string | null>(null);
  useEffect(() => {
    if (restartingVersion === null) return;
    const timer = window.setTimeout(() => setRestartingVersion(null), RESTART_GIVE_UP_MS);
    return () => window.clearTimeout(timer);
  }, [restartingVersion]);
  if (!updateToastVisible(state, dismissedOffer)) return null;
  const restarting = restartingVersion === state.version;
  const later = () => setDismissedOffer(state.offers);
  return (
    <div className="ptoasts dock">
      <div className="ptoast update" role="status">
        <span className="pt-icon" aria-hidden="true"><Icon name="download" size={16} /></span>
        <div className="pt-body">
          <div className="pt-title">CodeRay {state.version} is ready</div>
          <div className="pt-text">Restarting stops running agents. The update also installs when you quit CodeRay.</div>
          <div className="pt-actions">
            <button className="pbtn primary" disabled={restarting} onClick={() => { setRestartingVersion(state.version); restart(); }}>{restarting ? 'Restarting…' : 'Restart'}</button>
            <button className="pbtn" disabled={restarting} onClick={later}>Later</button>
          </div>
        </div>
        <button className="pt-x" aria-label="Dismiss" onClick={later}><Icon name="close" size={13} /></button>
      </div>
    </div>
  );
}
