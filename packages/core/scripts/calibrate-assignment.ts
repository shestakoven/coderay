import { realpathSync } from 'node:fs';
import { basename, join, posix, resolve } from 'node:path';
import { computeFileEdges } from '../src/graph/edges';
import { defaultIdeHome, projectDir, runDir } from '../src/home';
import { Indexer } from '../src/indexer/indexer';
import { createPythonAdapter } from '../src/lang/python';
import { createTypeScriptAdapter } from '../src/lang/typescript';
import { accepts, MIN_LOWER_BOUND, residualSamples, wilsonLowerBound, type EmbeddingRule, type ResidualSample } from '../src/map/embedding-check';
import { EmbeddingIndex } from '../src/map/embedding-index';
import { groupFiles } from '../src/map/grouping';
import { importTargets, isTestPath } from '../src/map/test-files';
import { ClaudeCliModel } from '../src/models/claude-cli';
import { LocalEmbedModel } from '../src/models/local-embed';

const RUNS = 2;
const MIN_COVERAGE = 0.2;
const SETTINGS: Record<EmbeddingRule['kind'], number[]> = {
  threshold: Array.from({ length: 37 }, (_, i) => Number((0.8 + i * 0.005).toFixed(3))),
  margin: Array.from({ length: 41 }, (_, i) => Number((i * 0.005).toFixed(3))),
};
const SHOWN: Record<EmbeddingRule['kind'], number[]> = {
  threshold: [0.8, 0.85, 0.88, 0.9, 0.92, 0.94],
  margin: [0, 0.02, 0.03, 0.05, 0.08, 0.1, 0.15, 0.2],
};
const LABEL: Record<EmbeddingRule['kind'], string> = { threshold: 'best similarity ≥', margin: 'lead over second ≥' };

interface Row {
  assigned: number;
  correct: number;
  lowerBound: number;
  coverage: number;
}

interface Run {
  label: string;
  components: number;
  samples: number;
  rows: Record<EmbeddingRule['kind'], Map<number, Row>>;
  directory: Row[];
}

const repos = process.argv.slice(2).map((path) => realpathSync(resolve(path)));
if (repos.length === 0) {
  console.error('usage: tsx packages/core/scripts/calibrate-assignment.ts <repository> [<repository> ...]');
  process.exit(1);
}

const home = defaultIdeHome();
const embed = new LocalEmbedModel({ cacheDir: join(home, 'models') });
const reasoning = new ClaudeCliModel({ model: 'haiku', runDir: runDir(home) });
const runs: Run[] = [];

for (const root of repos) {
  const name = basename(root);
  const adapters = await Promise.all([createTypeScriptAdapter(root), createPythonAdapter()]);
  const indexer = new Indexer({ root, adapters });
  await indexer.start();
  const files = indexer.files();
  await indexer.stop();

  console.error(`${name}: embedding ${files.length} files`);
  const embeddings = new EmbeddingIndex({ root, cacheFile: join(projectDir(home, root), 'embeddings.json'), model: embed });
  await embeddings.load();
  await embeddings.update(files);
  await embeddings.flush();
  const edges = computeFileEdges(files, adapters);
  const vectors = new Map(
    files.flatMap((file) => {
      const vector = embeddings.vector(file.path);
      return vector ? [[file.path, vector] as const] : [];
    }),
  );

  for (let run = 1; run <= RUNS; run += 1) {
    console.error(`${name}: grouping ${run} of ${RUNS} with Haiku`);
    const components = await groupFiles(
      {
        projectName: name,
        files: files.map((file) => ({ path: file.path, symbols: file.symbols.filter((s) => s.exported).map((s) => s.name) })),
        vectors,
        edges,
        previous: [],
        reservedIds: [],
      },
      reasoning,
    );
    const samples = residualSamples(components, files.map((file) => file.path), (path) => vectors.get(path), importTargets(edges));
    runs.push({
      label: `${name}, grouping ${run}`,
      components: components.length,
      samples: samples.length,
      rows: { threshold: rowsFor('threshold', samples), margin: rowsFor('margin', samples) },
      directory: [1, 2, 3].map((minSiblings) => directoryRow(components, minSiblings)),
    });
  }
}
await embed.close();

function rowsFor(kind: EmbeddingRule['kind'], samples: ResidualSample[]): Map<number, Row> {
  return new Map(
    SETTINGS[kind].map((min) => {
      const accepted = samples.filter((sample) => accepts({ kind, min }, sample));
      const correct = accepted.filter((sample) => sample.best === sample.own).length;
      return [min, { assigned: accepted.length, correct, lowerBound: wilsonLowerBound(correct, accepted.length), coverage: samples.length === 0 ? 0 : correct / samples.length }];
    }),
  );
}

function directoryRow(components: { id: string; files: string[] }[], minSiblings: number): Row {
  const owner = new Map(components.flatMap((component) => component.files.map((path) => [path, component.id] as const)));
  const byDir = new Map<string, string[]>();
  for (const path of owner.keys()) {
    const list = byDir.get(posix.dirname(path));
    if (list) list.push(path);
    else byDir.set(posix.dirname(path), [path]);
  }
  const judged = [...owner].filter(([path]) => !isTestPath(path));
  let assigned = 0;
  let correct = 0;
  for (const [path, id] of judged) {
    const siblings = (byDir.get(posix.dirname(path)) ?? []).filter((other) => other !== path);
    const ids = new Set(siblings.map((other) => owner.get(other)));
    if (siblings.length < minSiblings || ids.size !== 1) continue;
    assigned += 1;
    if (ids.has(id)) correct += 1;
  }
  return { assigned, correct, lowerBound: wilsonLowerBound(correct, assigned), coverage: judged.length === 0 ? 0 : correct / judged.length };
}

const qualifies = (row: Row | undefined) => !!row && row.lowerBound >= MIN_LOWER_BOUND && row.coverage >= MIN_COVERAGE;

function choose(kind: EmbeddingRule['kind']): { min: number; coverage: number } | null {
  const passing = SETTINGS[kind].filter((min) => runs.every((run) => qualifies(run.rows[kind].get(min))));
  const strictest = passing.at(-1);
  if (strictest === undefined) return null;
  return { min: strictest, coverage: Math.min(...runs.map((run) => run.rows[kind].get(strictest)!.coverage)) };
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const line = (rule: string, setting: string, row: Row) =>
  `| ${rule} | ${setting} | ${row.assigned} | ${row.assigned === 0 ? '—' : percent(row.correct / row.assigned)} | ${row.assigned === 0 ? '—' : percent(row.lowerBound)} | ${percent(row.coverage)} |`;
const threshold = choose('threshold');
const margin = choose('margin');
const best = [threshold && { kind: 'threshold' as const, ...threshold }, margin && { kind: 'margin' as const, ...margin }]
  .filter((choice) => choice !== null)
  .sort((a, b) => b.coverage - a.coverage)[0];
const decision = best ? `{ kind: '${best.kind}', min: ${best.min} }` : 'null';

console.log(
  [
    '# Instant assignment calibration',
    '',
    `Generated by \`packages/core/scripts/calibrate-assignment.ts\` on ${new Date().toISOString().slice(0, 10)} with \`${embed.id}\` and ${RUNS} Haiku groupings per repository.`,
    '',
    `Method: every directory is judged as if it were new (leave one directory out). Its files are compared with the component centroids computed without them, and a file that a stored glob or the test rule would place is skipped, so only files the embedding rule would really see are counted. A rule **assigns** a file when it accepts the file's nearest centroid, and is **correct** when that centroid belongs to the file's own component. The 95 % Wilson lower bound of correct / assigned must be at least ${percent(MIN_LOWER_BOUND)}, and coverage (correct / all counted files) at least ${percent(MIN_COVERAGE)}. The decision is the strictest setting that meets both in every run of every repository; repositories are never pooled. At runtime the IDE repeats the same check on each project's own grouping and keeps the rule off for a project that fails it. The directory-owner rule is measured on non-test files: a file is assigned when its siblings (at least the given number) all share one component. The test-subject rule is not measured: it decides where test files belong, so it agrees with the grouping by construction.`,
    '',
    ...runs.flatMap((run) => [
      `## ${run.label}: ${run.components} components, ${run.samples} counted files`,
      '',
      '| Rule | Setting | Assigned | Precision | 95 % lower bound | Coverage |',
      '|---|---|---|---|---|---|',
      ...(['threshold', 'margin'] as const).flatMap((kind) =>
        SHOWN[kind].map((min) => line(LABEL[kind], min.toFixed(3), run.rows[kind].get(min)!)),
      ),
      ...run.directory.map((row, i) => line(`directory owner, ≥ ${i + 1} sibling${i === 0 ? '' : 's'}`, '—', row)),
      '',
    ]),
    `**Decision: \`EMBEDDING_RULE = ${decision}\`**${decision === 'null' ? ': no setting met the bound with enough coverage in every run, so only the deterministic rules place new files.' : '.'}`,
  ].join('\n'),
);
