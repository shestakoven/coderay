#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const config = JSON.parse(readFileSync(process.env.FAKE_CLI_CONFIG, 'utf8'));
const args = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR ?? null;
const credentials = configDir === null ? null : join(configDir, 'fake-credentials.json');
const command = args.slice(0, 2).join(' ');
const record = (entry) => appendFileSync(config.record, `${JSON.stringify(entry)}\n`);

record({
  command, args, configDir, configDirExists: configDir !== null && existsSync(configDir),
  claudecode: process.env.CLAUDECODE ?? null, pid: process.pid,
  credentialVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].filter((name) => name in process.env),
});

const REFUSAL = 'Invalid code. Please make sure the full code was copied.\n';
const exit = (code) => process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));

if (command === 'auth status') {
  // statusEmail stands for credentials claude finds outside CLAUDE_CONFIG_DIR, such as a keychain item.
  const signedIn = config.statusEmail !== undefined || (credentials !== null && existsSync(credentials));
  const email = config.statusEmail ?? (signedIn ? JSON.parse(readFileSync(credentials, 'utf8')).email : null);
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(signedIn ? { loggedIn: true, email } : { loggedIn: false })}\n`);
  else process.stdout.write(signedIn ? `Logged in as ${email}\n` : 'Not logged in\n');
  exit(signedIn ? 0 : 1);
} else if (command === 'auth logout') {
  if (credentials !== null) rmSync(credentials, { force: true });
  process.stdout.write('Successfully logged out from your Anthropic account.\n');
  exit(0);
} else if (command === 'auth login') {
  login();
} else {
  process.stderr.write(`fake claude: unknown command ${JSON.stringify(args)}\n`);
  exit(2);
}

async function login() {
  // A grandchild in the same process group, as the real CLI keeps helpers around while it waits.
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  record({ helperPid: helper.pid });
  if (config.exitAtStart !== undefined) {
    process.stderr.write('Error: could not start the sign-in flow\n');
    helper.kill();
    return exit(config.exitAtStart);
  }
  const url = config.url;
  const output = [
    'Opening browser to sign in…\n',
    `If the browser didn't open, visit: \x1b[2m\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\\x1b[22m\n`,
    '\nPaste code here if prompted > ',
  ].join('');
  if (config.splitAt !== undefined) {
    const at = output.indexOf(url, config.splitAt === 'text' ? output.indexOf(url) + 1 : 0) + Math.floor(url.length / 2);
    process.stdout.write(output.slice(0, at));
    await new Promise((resolve) => setTimeout(resolve, 300));
    process.stdout.write(output.slice(at));
  } else {
    process.stdout.write(output);
  }
  let input = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    input = Buffer.concat([input, chunk]);
    writeFileSync(config.stdinFile, input);
    const newline = input.indexOf(10);
    if (newline === -1) return;
    if (config.refuseCodes) {
      // As the real claude does with a code it cannot use: it says so and keeps waiting.
      input = input.subarray(newline + 1);
      process.stderr.write(REFUSAL);
      return;
    }
    const outcome = config.codes?.[input.subarray(0, newline).toString()] ?? 'invalid';
    helper.kill();
    if (outcome === 'ok') writeFileSync(credentials, JSON.stringify({ email: config.email }));
    if (outcome === 'ok' || outcome === 'signed-out') {
      process.stdout.write('\nLogin successful.\n');
      return exit(0);
    }
    process.stderr.write('\nOAuth error: Invalid code\n');
    exit(1);
  });
  if (config.strayRefusal) {
    // Said before any code was sent, and recorded once the core has had time to read it.
    setTimeout(() => process.stderr.write(REFUSAL, () => setTimeout(() => record({ strayRefusal: true }), 100)), 100);
  }
}
