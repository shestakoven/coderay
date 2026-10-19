import { useEffect, useState } from 'react';
import type { UpdateState } from './update-state';

// Null outside the desktop shell, and until the shell has answered.
export function useDesktopUpdate(): { state: UpdateState | null; restart: () => void } {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    const bridge = window.coderayDesktop?.update;
    if (!bridge) return;
    let live = true;
    const stop = bridge.onChange(setState);
    // A change that arrived while the first answer was on its way is newer than that answer.
    void bridge.get().then((initial) => {
      if (live && initial) setState((current) => current ?? initial);
    });
    return () => {
      live = false;
      stop();
    };
  }, []);
  return { state, restart: () => void window.coderayDesktop?.update.restart() };
}
