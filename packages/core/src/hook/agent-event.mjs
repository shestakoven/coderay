// Event hook of the AI-Control IDE: reports what the agent does and passes the core's answer (a note for the agent) back to claude.
// It never blocks the agent, so every path exits 0.
import { readFileSync, writeSync } from 'node:fs';
import { request } from 'node:http';

const REPORT_TIMEOUT_MS = 10_000;
const DEFAULT_DEADLINE_MS = 3_540_000;

// node:http has no response timeout of its own, so a turn that waits for the user's answer can be held for as long as claude allows the hook to run.
function post(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers, signal: AbortSignal.timeout(timeoutMs) }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

const config = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8'));
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
try {
  const event = JSON.parse(input);
  // The end of a turn is where the core may hold the agent until the user has decided about its changes.
  const timeoutMs = event?.hook_event_name === 'Stop' ? config.deadlineMs ?? DEFAULT_DEADLINE_MS : REPORT_TIMEOUT_MS;
  const res = await post(
    new URL('event', `${config.url}/`),
    { authorization: `Bearer ${config.secret}`, 'content-type': 'application/json' },
    JSON.stringify({ sessionId: config.sessionId, event }),
    timeoutMs,
  );
  if (res.status === 200 && res.text !== '') writeSync(1, res.text);
} catch {
  // the core is unreachable: the agent goes on without the IDE's notes
}
process.exit(0);
