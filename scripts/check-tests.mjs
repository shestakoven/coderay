import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN = /\b(?:describe|it|test)(?:\.\w+)*\.(?:skip|only|todo|fixme|skipIf|runIf)\b|\.skip\(|\b(?:xit|xdescribe|fit|fdescribe)\s*\(/;
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'fixtures']);
const offenders = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(test|spec)\.tsx?$/.test(name)) {
      readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
        if (FORBIDDEN.test(line)) offenders.push(`${path}:${index + 1}: ${line.trim()}`);
      });
    }
  }
}

walk('packages');
walk('e2e');
if (offenders.length > 0) {
  console.error(`Focused, skipped or todo tests are not allowed:\n${offenders.join('\n')}`);
  process.exit(1);
}
