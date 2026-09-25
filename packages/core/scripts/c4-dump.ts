import { join } from 'node:path';
import { IdentifierClassifier } from '../src/c4/classify';
import { buildC4 } from '../src/c4/model';
import { computeFileEdges, unresolvedImports } from '../src/graph/edges';
import { Indexer } from '../src/indexer/indexer';
import { createPythonAdapter } from '../src/lang/python';
import { createTypeScriptAdapter } from '../src/lang/typescript';
import { ClaudeCliModel } from '../src/models/claude-cli';

// Usage: c4-dump <project> <ide-home>: indexes the project, classifies names with Haiku into <ide-home>, prints the C4 model.
const [root, home] = process.argv.slice(2) as [string, string];
const adapters = await Promise.all([createTypeScriptAdapter(root), createPythonAdapter()]);
const indexer = new Indexer({ root, adapters });
await indexer.start();
const files = indexer.files();
const edges = computeFileEdges(files, adapters);
const unresolved = unresolvedImports(files, adapters);
let changed: () => void = () => undefined;
const classifier = new IdentifierClassifier({
  model: new ClaudeCliModel({ model: 'haiku', runDir: join(home, 'run') }),
  cachePath: join(home, 'c4-classification.json'),
  onChange: () => changed(),
});
let built = buildC4(root, files, edges, [], unresolved, classifier.lookup);
for (let round = 0; built.pending.length > 0 && round < 5; round += 1) {
  console.log(`classifying ${built.pending.length} names…`);
  await new Promise<void>((resolve) => {
    changed = resolve;
    classifier.request(built.pending);
  });
  if (classifier.status().failure) console.log('failure:', classifier.status().failure);
  built = buildC4(root, files, edges, [], unresolved, classifier.lookup);
}
const model = built.model;
console.log(`${files.length} files, ${edges.length} edges, pending ${built.pending.length}`);
for (const c of model.containers) console.log(`C ${c.name} [${c.role} · ${c.tech}] files=${c.files} group=${c.group}`);
for (const e of model.externals) console.log(`E ${e.name} [${e.kind}] ${e.identifiers.join(', ')}`);
for (const l of model.links) console.log(`L ${l.from} -> ${l.to} ${l.protocol} ×${l.strength}`);
console.log('warnings', model.warnings);
classifier.stop();
await indexer.stop();
process.exit(0);
