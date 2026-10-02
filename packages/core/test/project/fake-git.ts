import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function fakeGit(dir: string, body: string): string {
  const path = join(dir, 'fake-git');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
