// Event hook of the AI-Control IDE: reports what the agent does and passes the core's answer (a note for the agent) back to claude.
// It never blocks the agent, so every path exits 0.
import { readFileSync, writeSync } from 'node:fs';

process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

const config = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8'));
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
try {
  const res = await fetch(new URL('event', `${config.url}/`), {
    method: 'POST',
    headers: { authorization: `Bearer ${config.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: config.sessionId, event: JSON.parse(input) }),
    signal: AbortSignal.timeout(10_000),
  });
  const answer = res.status === 200 ? await res.text() : '';
  if (answer !== '') writeSync(1, answer);
} catch {
  // the core is unreachable: the agent goes on without the IDE's notes
}
process.exit(0);
