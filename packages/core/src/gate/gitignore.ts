import { execFile } from 'node:child_process';

const GIT_TIMEOUT_MS = 2000;
// git names the path and the submodule in English only under the C locale.
const IN_SUBMODULE = /^fatal: Pathspec '(.*)' is in submodule '(.*)'$/m;

export interface IgnoreCheck { ignored: Set<string>; submodule: Set<string> }

type Run = { ok: true; ignored: Set<string> } | { ok: false; stderr: string };

function checkIgnore(root: string, rels: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['-C', root, 'check-ignore', '--stdin', '-z'],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout, stderr) => {
        // Exit 1 means nothing is ignored.
        if (error && (error as { code?: unknown }).code !== 1) resolve({ ok: false, stderr: String(stderr) });
        else resolve({ ok: true, ignored: new Set(String(stdout).split('\0').filter(Boolean)) });
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(rels.join('\0'));
  });
}

function showPrefix(root: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', root, 'rev-parse', '--show-prefix'], { timeout: GIT_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout) => resolve(error ? null : stdout.trim()));
  });
}

// The submodule a failed check names, relative to the root, as the paths given to it are.
async function submoduleOf(root: string, stderr: string): Promise<string | null> {
  const named = IN_SUBMODULE.exec(stderr);
  if (!named) return null;
  const prefix = await showPrefix(root);
  return prefix !== null && named[2]!.startsWith(prefix) ? named[2]!.slice(prefix.length) : null;
}

// Without --no-index git never reports a tracked file as ignored, which is the rule spec §3 wants.
// git refuses the whole batch for a path inside a submodule: such paths are set apart and the rest checked again.
export async function gitIgnored(root: string, rels: string[]): Promise<IgnoreCheck> {
  const submodule = new Set<string>();
  let rest = rels;
  while (rest.length > 0) {
    const run = await checkIgnore(root, rest);
    if (run.ok) return { ignored: run.ignored, submodule };
    const sub = await submoduleOf(root, run.stderr);
    const inside = sub === null ? [] : rest.filter((rel) => rel === sub || rel.startsWith(`${sub}/`));
    // Any other failure leaves every path enforced.
    if (inside.length === 0) break;
    for (const rel of inside) submodule.add(rel);
    rest = rest.filter((rel) => !submodule.has(rel));
  }
  return { ignored: new Set(), submodule };
}
