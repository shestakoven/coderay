import type { MapState } from './map-state';

export function DetailsPanel({ state }: { state: MapState }) {
  const { snapshot, selected } = state;
  const component = snapshot?.components.find((c) => c.id === selected);
  const file = snapshot?.files.find((f) => f.path === selected);

  if (component) {
    return (
      <aside className="details">
        <h2>{component.name}</h2>
        <p className="muted">
          {component.globs.join(', ')} · {component.files.length} files
        </p>
        <ul>
          {component.files.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      </aside>
    );
  }
  if (file) {
    return (
      <aside className="details">
        <h2>{file.path}</h2>
        <p className="muted">
          {file.lang}
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
  return null;
}
