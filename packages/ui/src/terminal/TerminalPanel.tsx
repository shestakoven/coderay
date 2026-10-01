import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../layout/Icon';
import type { TerminalHub, TerminalTab } from './terminal-hub';

export function TerminalPanel({ hub, tabs, visible }: { hub: TerminalHub; tabs: TerminalTab[]; visible: boolean }) {
  const [active, setActive] = useState<string | null>(null);
  const requested = useRef(false);
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0] ?? null;

  useEffect(() => {
    if (!visible || tabs.length > 0 || requested.current) return;
    requested.current = true;
    hub.create();
  }, [visible, tabs.length, hub]);

  useEffect(() => {
    if (tabs.length > 0) requested.current = false;
  }, [tabs.length]);

  useEffect(() => {
    if (!current || !visible) return;
    const timer = setTimeout(() => {
      hub.fit(current.id);
      hub.focus(current.id);
    }, 0);
    return () => clearTimeout(timer);
  }, [current?.id, visible, hub]);

  return (
    <div className="terminal-panel">
      <div className="terminal-tabs" role="tablist">
        {tabs.map((tab) => (
          <div key={tab.id} className={`terminal-tab${current?.id === tab.id ? ' on' : ''}${tab.exited ? ' exited' : ''}`}>
            <button role="tab" aria-selected={current?.id === tab.id} onClick={() => setActive(tab.id)}>{tab.title}{tab.exited ? ' (exited)' : ''}</button>
            <button className="terminal-close" aria-label={`Close ${tab.title}`} onClick={() => hub.close(tab.id)}>×</button>
          </div>
        ))}
        <button className="terminal-new" aria-label="New terminal" title="New terminal" onClick={() => { const id = hub.create(); if (id) setActive(id); }}>
          <Icon name="plus" size={16} />
        </button>
      </div>
      <div className="terminal-hosts">
        {tabs.map((tab) => (
          <TerminalHost key={tab.id} id={tab.id} hub={hub} shown={current?.id === tab.id && visible} />
        ))}
      </div>
    </div>
  );
}

function TerminalHost({ id, hub, shown }: { id: string; hub: TerminalHub; shown: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = element.current;
    if (!host) return;
    hub.attach(id, host);
    const observer = new ResizeObserver(() => hub.fit(id));
    observer.observe(host);
    return () => observer.disconnect();
  }, [id, hub]);
  return <div ref={element} className="terminal-host" hidden={!shown} />;
}
