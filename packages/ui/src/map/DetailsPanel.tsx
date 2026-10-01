import type { ReactNode } from 'react';
import type { MapComponent, MapFile } from '@ide/protocol';
import type { MapState } from './map-state';

export type DetailsTab = 'details' | 'changes';

export function DetailsPanel({ state, tab, onTab, changes }: { state: MapState; tab: DetailsTab; onTab: (tab: DetailsTab) => void; changes: (nodeId: string) => ReactNode }) {
  const { snapshot, selected } = state;
  const component = snapshot?.components.find((c) => c.id === selected);
  const file = snapshot?.files.find((f) => f.path === selected);
  if (!component && !file) return null;
  if (tab === 'changes' && selected) {
    return (
      <aside className="details">
        <Tabs tab={tab} onTab={onTab} />
        {changes(selected)}
      </aside>
    );
  }
  const tabs = <Tabs tab={tab} onTab={onTab} />;
  if (component) return <ComponentDetails component={component} tabs={tabs} />;
  return file ? <FileDetails file={file} owner={snapshot?.components.find((c) => c.id === file.componentId)} tabs={tabs} /> : null;
}

function Tabs({ tab, onTab }: { tab: DetailsTab; onTab: (tab: DetailsTab) => void }) {
  return (
    <div className="tabs" role="tablist">
      <button role="tab" aria-selected={tab === 'details'} className={tab === 'details' ? 'on' : ''} onClick={() => onTab('details')}>Details</button>
      <button role="tab" aria-selected={tab === 'changes'} className={tab === 'changes' ? 'on' : ''} onClick={() => onTab('changes')}>Changes</button>
    </div>
  );
}

function ComponentDetails({ component, tabs }: { component: MapComponent; tabs: ReactNode }) {
  return (
    <aside className="details">
      {tabs}
      <h2>{component.name}</h2>
      {component.summary && <p className="summary">{component.summary}</p>}
      {component.description ? (
        <p>{component.description}</p>
      ) : (
        <p className="muted">{component.source === 'folder' ? 'Folder component: no AI description yet.' : 'No description.'}</p>
      )}
      {component.stale && <p className="warn">Changed a lot since the last grouping.</p>}
      {component.keyFiles.length > 0 && (
        <>
          <h3>Key files</h3>
          <ul>
            {component.keyFiles.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </>
      )}
      <h3>Files</h3>
      <p className="muted">
        {component.source} · {component.globs.join(', ') || 'no globs'} · {component.files.length} files
      </p>
      <ul>
        {component.files.map((path) => (
          <li key={path}>{path}</li>
        ))}
      </ul>
    </aside>
  );
}

function FileDetails({ file, owner, tabs }: { file: MapFile; owner: MapComponent | undefined; tabs: ReactNode }) {
  return (
    <aside className="details">
      {tabs}
      <h2>{file.path}</h2>
      <p className="muted">
        {file.lang} · {owner ? owner.name : 'unassigned'}
        {file.manualAssignment ? ' (manual)' : ''}
        {file.parseError ? ' · ⚠ syntax errors' : ''}
      </p>
      <ul>
        {file.symbols.map((symbol) => (
          <li key={`${symbol.name}:${symbol.startLine}`}>
            <code>{symbol.kind}</code> {symbol.name}{' '}
            <span className="muted">
              L{symbol.startLine}–{symbol.endLine}
              {symbol.exported ? '' : ' · private'}
            </span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
