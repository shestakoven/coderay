import type { ClientMessage, GitClientMessage, GitServerMessage } from '@ide/protocol';

export type GitResult = Extract<GitServerMessage, { type: 'git.result' }>;
type Make = (requestId: string) => Exclude<GitClientMessage, { type: 'git.refresh' }>;

export class GitClient {
  private readonly waiting = new Map<string, (result: GitResult) => void>();

  constructor(private readonly send: (message: ClientMessage) => boolean) {}

  refresh(): void {
    this.send({ type: 'git.refresh' });
  }

  request(make: Make): Promise<GitResult> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      this.waiting.set(requestId, resolve);
      if (!this.send(make(requestId))) this.fail(requestId, 'Not connected to the CodeRay core.');
    });
  }

  handle(result: GitResult): void {
    const done = this.waiting.get(result.requestId);
    if (!done) return;
    this.waiting.delete(result.requestId);
    done(result);
  }

  dropAll(): void {
    for (const requestId of [...this.waiting.keys()]) this.fail(requestId, 'The connection to the CodeRay core was lost.');
  }

  private fail(requestId: string, error: string): void {
    this.handle({ type: 'git.result', requestId, error });
  }
}
