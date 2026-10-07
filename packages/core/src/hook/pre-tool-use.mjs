// PreToolUse hook of the AI-Control IDE. Exit 2 blocks the call; exit 1, plain output and a timed-out hook all let it run (spike v1, v2, 2c).
import { readFileSync, writeSync } from 'node:fs';
import { request } from 'node:http';

const DEFAULT_DEADLINE_MS = 3_540_000;
const MAX_REASON_CHARS = 1000;
const MAX_WRITE_RETRIES = 20;
let finished = false;

// A write that would wait for a reader that never drains must not keep the hook alive: the exit is what blocks the call.
function writeOut(fd, text) {
  const bytes = Buffer.from(text);
  let written = 0;
  for (let retries = 0; written < bytes.length && retries < MAX_WRITE_RETRIES;) {
    try {
      written += writeSync(fd, bytes, written);
    } catch (error) {
      if (error?.code !== 'EAGAIN') return false;
      retries += 1;
    }
  }
  return written === bytes.length;
}

function block(why) {
  if (finished) return;
  finished = true;
  writeOut(2, `IDE: ${String(why).slice(0, MAX_REASON_CHARS)}`);
  process.exit(2);
}

function answer(decision) {
  if (finished) return;
  const output = { hookSpecificOutput: { hookEventName: 'PreToolUse', ...decision } };
  if (!writeOut(1, JSON.stringify(output))) return block('could not deliver the decision');
  finished = true;
  process.exit(0);
}

process.on('uncaughtException', (error) => block(`the hook failed: ${error?.message ?? error}`));
process.on('unhandledRejection', (error) => block(`the hook failed: ${error?.message ?? error}`));

const config = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8'));
const url = new URL(config.url);
setTimeout(() => block('the user did not respond in time, so the call is blocked'), config.deadlineMs ?? DEFAULT_DEADLINE_MS);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const req = request(
    {
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.secret}` },
    },
    (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('error', (error) => block(`the IDE core connection failed: ${error.message}`));
      res.on('end', () => {
        if (res.statusCode !== 200) return block(`the IDE core answered ${res.statusCode}`);
        const decision = JSON.parse(body);
        const valid = (decision?.permissionDecision === 'allow' || decision?.permissionDecision === 'deny')
          && typeof decision.permissionDecisionReason === 'string';
        if (!valid) return block('the IDE core sent an answer the hook cannot read');
        const context = typeof decision.additionalContext === 'string' && decision.additionalContext !== '' ? { additionalContext: decision.additionalContext } : {};
        answer({ permissionDecision: decision.permissionDecision, permissionDecisionReason: decision.permissionDecisionReason, ...context });
      });
    },
  );
  req.on('error', (error) => block(`IDE core unreachable: ${error.message}`));
  req.end(input);
});
