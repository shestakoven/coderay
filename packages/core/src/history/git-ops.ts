import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRun } from '../git/git-run';
import type { HistoryCall, ToolCall } from '../watchdog/activity';

const KEPT = 50;
const READ_MS = 10_000;

export interface GitOpsOptions {
  root: string;
  settle(toolUseId: string): Promise<void>;
}

// What a git command that can move HEAD wrote: the files whose content differs between HEAD before and after the call, and that now hold what HEAD holds.
// A file the call wrote that is not among them (cherry-pick -n, a hook, a write over what git checked out) is the agent's.
export class GitOps {
  private readonly open = new Map<string, ToolCall>();
  private readonly done = new Map<string, ReadonlySet<string>>();

  constructor(private readonly o: GitOpsOptions) {}

  begin(call: ToolCall): void {
    if (call.history !== undefined && call.history.length > 0) this.open.set(call.toolUseId, call);
  }

  // undefined while the call runs.
  moved(toolUseId: string): ReadonlySet<string> | undefined {
    return this.done.get(toolUseId);
  }

  toolEnded(toolUseId: string): Promise<void> {
    return this.open.get(toolUseId)?.background ? Promise.resolve() : this.end(toolUseId);
  }

  end(toolUseId: string): Promise<void> {
    const call = this.open.get(toolUseId);
    if (!call) return Promise.resolve();
    this.open.delete(toolUseId);
    return this.finish(toolUseId, call.history!);
  }

  endAll(): Promise<void> {
    return Promise.all([...this.open.keys()].map((id) => this.end(id))).then(() => undefined);
  }

  private async finish(toolUseId: string, history: HistoryCall[]): Promise<void> {
    const moved = new Set<string>();
    for (const call of history) for (const rel of await this.changed(call)) moved.add(rel);
    this.done.set(toolUseId, moved);
    if (this.done.size > KEPT) this.done.delete(this.done.keys().next().value as string);
    await this.o.settle(toolUseId);
  }

  // When git cannot say, nothing is git's but its refs: the files fall to the watchdog, as before.
  private async changed({ top, head }: HistoryCall): Promise<string[]> {
    if (head === null) return [];
    const run = createRun(top);
    const read = { readOnly: true, timeoutMs: READ_MS };
    try {
      const after = (await run(['rev-parse', '--verify', 'HEAD'], read)).trim();
      if (after === head) return [];
      const [moved, differs, conflicted] = await Promise.all([
        run(['diff', '--name-status', '-z', '--no-renames', head, after], read),
        run(['diff', '--name-only', '-z', '--no-renames', after], read),
        run(['diff', '--name-only', '-z', '--diff-filter=U'], read),
      ]);
      // Git's are the files that now hold what HEAD holds, or git's conflict: one the call wrote over, or brought back after git deleted it, is the agent's.
      const unmerged = new Set(conflicted.split('\0'));
      const altered = new Set(differs.split('\0').filter((path) => !unmerged.has(path)));
      const fields = moved.split('\0');
      const paths: string[] = [];
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const path = fields[i + 1]!;
        if (!altered.has(path) && !(fields[i] === 'D' && existsSync(join(top, path)))) paths.push(path);
      }
      return paths.map((path) => relative(this.o.root, join(top, path))).filter((rel) => !rel.startsWith('..'));
    } catch (error) {
      console.error('git ops: could not read what git changed', error);
      return [];
    }
  }
}
