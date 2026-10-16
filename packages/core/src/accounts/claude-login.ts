import { execFile, spawn } from 'node:child_process';
import { isRecord, parseJson } from '../json';
import { killGroup } from '../models/claude-cli';
import type { LoginFlow } from './account-login';
import { AccountError, accountEnv } from './account-store';

const STATUS_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 64 * 1024;
// OSC sequences (claude prints the URL as an OSC 8 hyperlink) end with BEL or ST; CSI sequences are colours and cursor moves.
const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g;
// The URL must be followed by a separator, so one cut off at the end of a chunk is not taken.
const URL_PATTERN = /https:\/\/[^\s\x00-\x1f"'<>]+(?=[\s\x00-\x1f])/;

export function loginUrl(output: string): string | null {
  return URL_PATTERN.exec(output.replace(ESCAPES, ''))?.[0] ?? null;
}

/** `claude auth login` in the new account's config directory, then `claude auth status` for its e-mail. */
export function claudeLogin(claude: string): LoginFlow {
  return {
    start(home, _method, _secret, report) {
      // Detached so that cancelling stops claude's whole process group.
      const child = spawn(claude, ['auth', 'login'], { env: accountEnv(home.dir), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      let output = '';
      let shown = false;
      let over = false;
      const read = (chunk: string): void => {
        if (shown || over) return;
        output = (output + chunk).slice(0, MAX_OUTPUT_CHARS);
        const url = loginUrl(output);
        if (url === null) return;
        shown = true;
        report({ kind: 'waiting', url, userCode: null });
      };
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', read);
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', read);
      child.stdin?.on('error', () => {});
      // A core that dies without its shutdown path must not leave a sign-in running that could still save credentials.
      const onCoreExit = (): void => killGroup(child);
      if (child.pid !== undefined) process.on('exit', onCoreExit);
      child.once('error', () => {
        if (over) return;
        over = true;
        report({ kind: 'failed', error: `CodeRay could not run ${claude}.` });
      });
      child.once('exit', (code) => {
        process.removeListener('exit', onCoreExit);
        if (over) return;
        if (code !== 0) {
          over = true;
          report({ kind: 'failed', error: `The sign-in did not finish (claude exited with ${code === null ? 'a signal' : `code ${code}`}).` });
          return;
        }
        report({ kind: 'checking' });
        const status = execFile(claude, ['auth', 'status', '--json'], { env: accountEnv(home.dir), timeout: STATUS_TIMEOUT_MS }, (_error, stdout) => {
          if (over) return;
          over = true;
          // A signed-out claude exits with code 1 but still prints its status.
          const parsed = parseJson(String(stdout));
          if (!isRecord(parsed) || parsed.loggedIn !== true) {
            report({ kind: 'failed', error: 'claude finished, but the new account is not signed in.' });
            return;
          }
          report({ kind: 'done', email: typeof parsed.email === 'string' && parsed.email !== '' ? parsed.email : 'unknown email', plan: null });
        });
        status.stdin?.end();
      });
      return {
        submitCode(code) {
          if (!child.stdin?.writable) throw new AccountError('No sign-in is waiting for a code.');
          child.stdin.write(`${code}\n`);
        },
        cancel() {
          over = true;
          if (child.exitCode === null && child.signalCode === null) killGroup(child);
        },
      };
    },
  };
}
