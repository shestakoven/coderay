import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const defaultIdeHome = (): string => process.env.IDE_HOME ?? join(homedir(), '.ide');
export const projectDir = (home: string, root: string): string =>
  join(home, 'projects', createHash('sha256').update(root).digest('hex').slice(0, 16));
export const runDir = (home: string): string => join(home, 'run');
