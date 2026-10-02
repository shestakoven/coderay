import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { promisify } from 'node:util';
import { gitErrorMessage } from './git';
import { discardTarget, prepareTarget, type ProjectResult } from './target';

const run = promisify(execFile);

export interface CreateOptions {
  parent: string;
  name: string;
  git?: string;
}

export async function createProject({ parent, name, git = 'git' }: CreateOptions): Promise<ProjectResult> {
  const target = prepareTarget(parent, name);
  if ('error' in target) return target;
  if (target.created) {
    try {
      mkdirSync(target.path);
    } catch (error) {
      return { error: `Could not create the folder: ${(error as Error).message}` };
    }
  }
  try {
    await run(git, ['init', '-q'], { cwd: target.path });
  } catch (error) {
    discardTarget(target);
    return { error: gitErrorMessage(error, String((error as { stderr?: string }).stderr ?? '')) };
  }
  return { root: target.path };
}
