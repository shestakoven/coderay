// Usage: node --import tsx packages/core/scripts/review-graph-probe.ts <project> <git-range>
// Example: review-graph-probe /Users/me/code/KVARK HEAD~40..HEAD
// Builds the review graph of the files a git range changed, as the core would, and prints its shape.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReviewGraphFile } from '@ide/protocol';
import { Indexer } from '../src/indexer/indexer';
import { createPythonAdapter } from '../src/lang/python';
import { createTypeScriptAdapter } from '../src/lang/typescript';
import { folderComponents } from '../src/map/folder-components';
import { readMapFile } from '../src/map/map-file';
import { buildReviewGraph } from '../src/review/review-graph';

const [root, range] = process.argv.slice(2) as [string, string];
const base = range.split('..')[0]!;
const git = (...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const changed: ReviewGraphFile[] = git('diff', '--name-status', '-M', range)
  .split('\n')
  .filter(Boolean)
  .flatMap((line): ReviewGraphFile[] => {
    const [status, first, second] = line.split('\t') as [string, string, string | undefined];
    const entry = (path: string, before: string | null, after: string | null): ReviewGraphFile => ({ path, before, after, step: null, external: false, added: 0, removed: 0 });
    if (status.startsWith('R') && second !== undefined) return [entry(first, 'b', null), entry(second, null, 'a')];
    if (status === 'A') return [entry(first, null, 'a')];
    if (status === 'D') return [entry(first, 'b', null)];
    return [entry(first, 'b', 'a')];
  });

const adapters = await Promise.all([createTypeScriptAdapter(root), createPythonAdapter()]);
const indexer = new Indexer({ root, adapters });
await indexer.start();
const current = indexer.files();

const map = await readMapFile(root);
const saved = [...(map.ai ?? []), ...map.manual];
const byId = new Map(saved.map((c) => [c.id, { id: c.id, name: c.name, files: [...c.files] }]));
for (const [path, id] of map.assignments) byId.get(id)?.files.push(path);
const components = byId.size > 0
  ? [...byId.values()]
  : folderComponents(current.map((f) => f.path)).map((c) => ({ id: c.id, name: c.name, files: c.files }));
console.log(`${current.length} files, ${components.length} components (${byId.size > 0 ? 'saved map' : 'folders'}), ${changed.length} changed in ${range}`);

const graph = await buildReviewGraph({
  changed, current, components, adapters, plan: null,
  readBefore: async (path) => { try { return git('show', `${base}:${path}`); } catch { return null; } },
  readNow: async (path) => readFile(join(root, path), 'utf8').catch(() => null),
});

const count = (values: string[]): string =>
  Object.entries(values.reduce<Record<string, number>>((acc, value) => ({ ...acc, [value]: (acc[value] ?? 0) + 1 }), {})).map(([k, v]) => `${k}=${v}`).join(' ');
const withFiles = graph.parts.filter((part) => part.files.length > 0);
console.log(`parts ${graph.parts.length} (${count(graph.parts.map((p) => p.status))}); with changes ${withFiles.length}; largest ${Math.max(0, ...withFiles.map((p) => p.files.length))} changed files`);
console.log(`links ${graph.links.length} (${count(graph.links.map((l) => l.state))})`);
for (const part of withFiles.sort((a, b) => b.files.length - a.files.length)) console.log(`  ${part.status.padEnd(9)} ${String(part.files.length).padStart(4)} files  ${part.title}${part.broken.length > 0 ? `  [${part.broken.length} broken import(s)]` : ''}`);
console.log('partial:', graph.partial);
await indexer.stop();
process.exit(0);
