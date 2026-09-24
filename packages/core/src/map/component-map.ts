import { posix } from 'node:path';
import type { MapComponent } from '@ide/protocol';
import { folderComponents } from './folder-components';
import type { AiComponent, ManualComponent } from './map-file';

export interface ManualEvidence {
  owner: Map<string, string>;
  dangling: string[];
}

export function matchManual(
  paths: string[],
  manual: ManualComponent[],
  assignments: ReadonlyMap<string, string>,
  knownIds: ReadonlySet<string>,
): ManualEvidence {
  const owner = new Map<string, string>();
  const dangling: string[] = [];
  for (const path of paths) {
    const assigned = assignments.get(path);
    if (assigned !== undefined && knownIds.has(assigned)) {
      owner.set(path, assigned);
      continue;
    }
    if (assigned !== undefined) dangling.push(path);
    const component = manual.find((m) => m.files.includes(path) || m.globs.some((glob) => posix.matchesGlob(path, glob)));
    if (component) owner.set(path, component.id);
  }
  return { owner, dangling };
}

export function ownedGlobs(components: Pick<AiComponent, 'id' | 'files'>[], allPaths: string[]): Map<string, string[]> {
  const owner = new Map(components.flatMap((component) => component.files.map((path) => [path, component.id] as const)));
  const owners = new Map<string, string | null>();
  for (const path of allPaths) {
    const id = owner.get(path) ?? null;
    for (let dir = posix.dirname(path); ; dir = posix.dirname(dir)) {
      const seen = owners.get(dir);
      owners.set(dir, seen === undefined || seen === id ? id : null);
      if (dir === '.') break;
    }
  }
  const globs = new Map(components.map((component) => [component.id, [] as string[]]));
  for (const [dir, id] of owners) {
    if (id === null || (dir !== '.' && owners.get(posix.dirname(dir)) === id)) continue;
    globs.get(id)?.push(dir === '.' ? '**' : `${dir}/**`);
  }
  for (const list of globs.values()) list.sort();
  return globs;
}

export interface ProjectionInput {
  paths: string[];
  manual: ManualComponent[];
  ai: AiComponent[] | null;
  owner: ReadonlyMap<string, string>;
}

export function projectComponents({ paths, manual, ai, owner }: ProjectionInput): MapComponent[] {
  const membersOf = new Map<string, string[]>();
  for (const path of paths) {
    const id = owner.get(path);
    if (id === undefined) continue;
    const members = membersOf.get(id);
    if (members) members.push(path);
    else membersOf.set(id, [path]);
  }
  const manualIds = new Set(manual.map((component) => component.id));
  const generated: MapComponent[] = ai
    ? ai.flatMap((component) => {
        const files = membersOf.get(component.id) ?? [];
        if (files.length === 0) return [];
        return [
          {
            id: component.id,
            name: component.name,
            summary: component.summary,
            description: component.description,
            files,
            keyFiles: component.keyFiles.filter((path) => files.includes(path)),
            globs: component.globs,
            source: 'ai' as const,
            stale: false,
          },
        ];
      })
    : folderComponents(paths.filter((path) => !manualIds.has(owner.get(path) ?? '')));
  const manualComponents: MapComponent[] = manual.map((component) => ({
    id: component.id,
    name: component.name,
    summary: component.summary,
    description: component.description,
    files: membersOf.get(component.id) ?? [],
    keyFiles: [],
    globs: component.globs,
    source: 'manual',
    stale: false,
  }));
  return [...generated, ...manualComponents];
}
