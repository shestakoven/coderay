import { execFile } from 'node:child_process';

const GIT_TIMEOUT_MS = 2000;

// Without --no-index git never reports a tracked file as ignored, which is the rule spec §3 wants.
export function gitIgnored(root: string, rels: string[]): Promise<Set<string>> {
  if (rels.length === 0) return Promise.resolve(new Set());
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['-C', root, 'check-ignore', '--stdin', '-z'],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        // Exit 1 means nothing is ignored; any other failure leaves every path enforced.
        if (error && (error as { code?: unknown }).code !== 1) {
          resolve(new Set());
          return;
        }
        resolve(new Set(String(stdout).split('\0').filter(Boolean)));
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(rels.join('\0'));
  });
}
