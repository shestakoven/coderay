import type { MapComponent, MapFile } from '@ide/protocol';
import type { MapState } from './map-state';

export function DetailsPanel({ state }: { state: MapState }) {
  const { snapshot, selected } = state;
  const component = snapshot?.components.find((c) => c.id === selected);
  const file = snapshot?.files.find((f) => f.path === selected);
  if (component) return <ComponentDetails component={component} />;
  if (file) return <FileDetails file={file} owner={snapshot?.components.find((c) => c.id === file.componentId)} />;
  return <aside className="details muted">Select a component or a file</aside>;
}

function ComponentDetails({ component }: { component: MapComponent }) {
  return (
    <aside className="details">
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

function FileDetails({ file, owner }: { file: MapFile; owner: MapComponent | undefined }) {
  return (
    <aside className="details">
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
