import type { CSSProperties } from 'react';
import type { StatusKind } from './project-status';
import { projectHue, projectLetter } from './projects-state';

// The status badge colours come from an `s-<kind>` class on an ancestor.
export function Mono({ name, root, kind, size = 18 }: { name: string; root: string; kind?: StatusKind; size?: number }) {
  return (
    <span className="pmono" style={{ '--h': projectHue(root), '--sz': `${size}px` } as CSSProperties}>
      {projectLetter(name)}
      {kind !== undefined && kind !== 'idle' && <i className="pm-badge" />}
    </span>
  );
}
