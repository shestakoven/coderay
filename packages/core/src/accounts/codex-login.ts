import { rmSync } from 'node:fs';
import type { LoginMethod } from '@ide/protocol';
import { isRecord } from '../json';
import type { ProcessExit } from '../agent/claude-process';
import { handshake, startAppServer, withAppServer } from '../agent/codex/app-server';
import { codexUnder, type CodexCommand } from '../agent/codex/command';
import type { AccountLoginCompletedNotification, LoginAccountResponse } from '../agent/codex/protocol';
import type { Incoming } from '../agent/codex/rpc';
import type { LoginFlow } from './account-login';
import type { SignedHome } from './account-homes';

// Every plan id of 0.160.0; one a later codex adds shows as codex names it.
const PLANS: Record<string, string | null> = {
  free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', promax: 'Pro Max', team: 'Team',
  business: 'Business', self_serve_business_prolite: 'Business', self_serve_business_usage_based: 'Business',
  enterprise: 'Enterprise', ent26: 'Enterprise', enterprise_cbp_automation: 'Enterprise', enterprise_cbp_usage_based: 'Enterprise',
  edu: 'Edu', edu_plus: 'Edu Plus', edu_pro: 'Edu Pro', unknown: null,
};
const CANCEL_TIMEOUT_MS = 2_000;
const READ_TIMEOUT_MS = 20_000;
// How long an API-key sign-in waits for account/login/completed before CodeRay reads the account itself.
const COMPLETED_WAIT_MS = 3_000;
const URL_TAIL = /(https?:\/\/[^\s?#]*)[?#]\S*/g;

// The page the view opens comes from codex: only a web address is opened.
const https = (value: unknown): value is string => typeof value === 'string' && value.startsWith('https://');

interface Named { email: string; plan: string | null }

function nameOf(answer: unknown): Named | null {
  const account = isRecord(answer) ? answer.account : null;
  if (!isRecord(account)) return null;
  if (account.type === 'apiKey') return { email: 'API key', plan: null };
  if (account.type === 'amazonBedrock') return { email: 'Amazon Bedrock', plan: null };
  if (account.type !== 'chatgpt') return { email: 'Codex account', plan: null };
  const plan = typeof account.planType === 'string' ? (Object.hasOwn(PLANS, account.planType) ? PLANS[account.planType] ?? null : account.planType) : null;
  return { email: typeof account.email === 'string' && account.email !== '' ? account.email : 'ChatGPT account', plan };
}

// codex's words can repeat the key, the code or the sign-in URL it was given or showed: what the user reads keeps none of them.
function scrub(text: string, hidden: readonly string[]): string {
  return hidden.reduce((out, value) => (value.length < 4 ? out : out.replaceAll(value, '…')), text.replace(URL_TAIL, '$1'));
}

function stopped(exit: ProcessExit): string {
  if (exit.error !== null) return `CodeRay could not run Codex (${exit.error}).`;
  const last = exit.stderr.trim().split('\n').at(-1);
  return `Codex stopped before the sign-in finished (${exit.signal ?? `code ${exit.code}`})${last ? `: ${last}` : '.'}`;
}

function loginParams(method: LoginMethod, secret: string | null): object {
  if (method === 'api-key') return { type: 'apiKey', apiKey: secret ?? '' };
  return { type: method === 'device-code' ? 'chatgptDeviceCode' : 'chatgpt' };
}

/** A short-lived app-server in the new account's home runs codex's own sign-in: ChatGPT in the browser, a device code, or an API key. */
export function codexLogin(command: () => CodexCommand): LoginFlow {
  return {
    start(home, method, secret, report) {
      const hidden = secret === null ? [] : [secret];
      // `over`: the flow has had its last word or was cancelled; `named`: the account codex signed in, kept once codex has stopped.
      let over = false;
      let cancelled = false;
      let checking = false;
      let reading = false;
      let loginId: string | null = null;
      let named: Named | null = null;

      function fail(error: string): void {
        if (over) return;
        over = true;
        report({ kind: 'failed', error: scrub(error, hidden) });
        void server.kill();
      }

      function showChecking(): void {
        if (checking) return;
        checking = true;
        report({ kind: 'checking' });
      }

      // Once: on account/login/completed, or for an API key after a short wait, as 0.160.0 may store a key without that notification.
      function check(): void {
        if (over || reading) return;
        reading = true;
        showChecking();
        void server.rpc.request('account/read', { refreshToken: false }, READ_TIMEOUT_MS).then((answer) => {
          if (over) return;
          const account = nameOf(answer);
          if (account === null) return fail('Codex finished, but the new account is not signed in.');
          over = true;
          named = account;
          void server.kill();
        }, (error: Error) => fail(`Codex could not read the new account (${error.message}).`));
      }

      function heard({ method: name, params }: Incoming): void {
        if (over || name !== 'account/login/completed' || !isRecord(params)) return;
        const done = params as Partial<AccountLoginCompletedNotification>;
        if (typeof done.loginId === 'string' && loginId !== null && done.loginId !== loginId) return;
        if (done.success !== true) return fail(typeof done.error === 'string' && done.error !== '' ? done.error : 'The sign-in did not finish.');
        check();
      }

      const server = startAppServer(codexUnder(command(), home), { cwd: home.dir, onNotification: heard });
      void server.exited.then((exit) => {
        if (named !== null && !cancelled) {
          report({ kind: 'done', ...named });
          return;
        }
        // codex goes on writing its state into its home, even after the directory was removed under it: an unsaved one goes once codex has stopped.
        try {
          rmSync(home.dir, { recursive: true, force: true });
        } catch (error) {
          console.error('accounts: could not remove an unfinished Codex sign-in directory', error);
        }
        fail(stopped(exit));
      });
      void (async () => {
        try {
          await handshake(server.rpc);
          if (over) return;
          const started = await server.rpc.request<LoginAccountResponse | null>('account/login/start', loginParams(method, secret));
          if (over) return;
          if (started?.type === 'chatgpt' && https(started.authUrl)) {
            loginId = started.loginId;
            report({ kind: 'waiting', url: started.authUrl, userCode: null });
          } else if (started?.type === 'chatgptDeviceCode' && https(started.verificationUrl) && typeof started.userCode === 'string') {
            loginId = started.loginId;
            hidden.push(started.userCode);
            report({ kind: 'waiting', url: started.verificationUrl, userCode: started.userCode });
          } else if (started?.type === 'apiKey') {
            showChecking();
            setTimeout(check, COMPLETED_WAIT_MS).unref();
          } else {
            fail('Codex started a sign-in CodeRay cannot show.');
          }
        } catch (error) {
          fail(`Codex could not start the sign-in (${(error as Error).message}).`);
        }
      })();
      return {
        cancel() {
          cancelled = true;
          if (over) return;
          over = true;
          // A sign-in codex has not named yet, or has finished, has nothing to cancel in codex.
          if (loginId === null || checking) void server.kill();
          else void server.rpc.request('account/login/cancel', { loginId }, CANCEL_TIMEOUT_MS).catch(() => {}).finally(() => void server.kill());
        },
      };
    },
  };
}

/** Signs the account out in its own home (codex drops its tokens), whatever happens to the directory afterwards. */
export function codexLogout(command: () => CodexCommand): (home: SignedHome) => Promise<void> {
  return async (home) => {
    try {
      await withAppServer(codexUnder(command(), home), home.dir, (rpc) => rpc.request('account/logout', {}));
    } catch (error) {
      console.error('accounts: codex could not sign the account out; its directory goes all the same', error);
    }
  };
}
