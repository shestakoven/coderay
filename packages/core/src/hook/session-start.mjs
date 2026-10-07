// SessionStart hook of the AI-Control CodeRay: tells the core that claude runs CodeRay's hooks. It never blocks a session, so every path exits 0.
import { readFileSync } from 'node:fs';

process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

const config = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8'));
for await (const _ of process.stdin) {
  // drain
}
try {
  await fetch(new URL('alive', `${config.url}/`), {
    method: 'POST',
    headers: { authorization: `Bearer ${config.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: config.sessionId }),
    signal: AbortSignal.timeout(10_000),
  });
} catch {
  // the core is unreachable; the session decides what that means
}
process.exit(0);
