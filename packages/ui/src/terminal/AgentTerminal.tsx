import { useEffect, useRef } from 'react';
import type { TerminalHub, TerminalTab } from './terminal-hub';

export function AgentTerminal({ hub, tab, visible, onRestart, onBack }: {
  hub: TerminalHub;
  tab: TerminalTab | null;
  visible: boolean;
  onRestart: () => void;
  onBack: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const id = tab?.id ?? null;
  const generation = tab?.generation ?? 0;

  useEffect(() => {
    const host = element.current;
    if (!host || id === null) return;
    host.replaceChildren();
    hub.attach(id, host);
    const observer = new ResizeObserver(() => hub.fit(id));
    observer.observe(host);
    return () => observer.disconnect();
  }, [id, generation, hub]);

  useEffect(() => {
    if (!visible || id === null) return;
    const timer = setTimeout(() => {
      hub.fit(id);
      hub.focus(id);
    }, 0);
    return () => clearTimeout(timer);
  }, [visible, id, generation, hub]);

  return (
    <div className="agent-terminal" data-testid="agent-terminal">
      <div ref={element} className="agent-terminal-host" onMouseDown={() => id !== null && hub.focus(id)} />
      {tab === null && <div className="agent-terminal-state">Starting claude…</div>}
      {tab?.exited && (
        <div className="agent-terminal-exited" role="status">
          <span>claude exited</span>
          <span className="spacer" />
          <button onClick={onBack}>Back to chat</button>
          <button className="primary" onClick={onRestart}>Restart</button>
        </div>
      )}
    </div>
  );
}
