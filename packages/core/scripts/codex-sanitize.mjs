// Copies a verification transcript of `codex app-server` with paths, ids and account details replaced, as provenance for the fake's fixtures.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname } from 'node:path';

const [from, to, project] = process.argv.slice(2);
if (!from || !to || !project) {
  console.error('usage: node codex-sanitize.mjs <transcript.jsonl> <out.jsonl> <probe project dir>');
  process.exit(2);
}
const ids = new Map();
const idOf = (kind, value) => {
  if (!ids.has(value)) ids.set(value, `${kind}-${[...ids.values()].filter((id) => id.startsWith(`${kind}-`)).length + 1}`);
  return ids.get(value);
};
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The transcripts name a path with or without macOS's /private prefix.
const both = (path) => [path, path.replace(/^\/private(?=\/)/, '')];
const PATHS = [[project, '$CWD'], [dirname(project), '$SCRATCH'], [homedir(), '$HOME']].flatMap(([path, name]) => both(path).map((variant) => [variant, name]));
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g;
const DROP = new Set(['remoteControl/status/changed']);
const scrub = (text) => PATHS.reduce((out, [path, name]) => out.replaceAll(path, name), text)
  .replaceAll(userInfo().username, 'owner')
  .replace(EMAIL, 'owner@example.com')
  .replace(/cf-ray: [\w-]+/g, 'cf-ray: …').replace(/req_[0-9a-f]{16,}/g, 'req_…')
  .replace(/"(chatgptAccountId|installationId|serverName|environmentId|backendOrigin|sha|originUrl)":"[^"]*"/g, '"$1":"…"')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => idOf('id', id))
  .replace(/\b(msg|rs)_[0-9a-f]{16,}\b/g, (id, kind) => idOf(kind, id));

// The owner's full name where the system knows it (macOS `id -F`): it must never reach a copy.
let fullName = '';
try {
  fullName = execFileSync('id', ['-F'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {
  // Not macOS: the user name and the paths are still checked.
}
const DENY = [
  ["the owner's user name", new RegExp(`\\b${escape(userInfo().username)}\\b`, 'i')],
  ...fullName.split(/\s+/).filter((part) => part.length > 2).map((part) => ["the owner's name", new RegExp(`\\b${escape(part)}\\b`, 'i')]),
  ['a home or scratch path', /\/Users\/|\/home\/|\/tmp\/claude-\d+/],
  ['an e-mail address', new RegExp(`(?<![\\w.+-])(?!owner@example\\.com\\b)${EMAIL.source}`)],
  ['a unique id', /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/],
  ['a linked account', /\blink_[0-9a-f]{16,}|link_owner_profile/],
  ['a credential', /\bsk-[\w-]{16,}|\beyJ[\w-]{10,}\.|"(?:access|refresh|id)_token"|Bearer [\w.-]{8,}/],
  ['a request trace', /cf-ray: [0-9a-f]|chatgpt\.com\/backend/],
];

const out = [];
for (const line of readFileSync(from, 'utf8').split('\n')) {
  if (line.trim() === '') continue;
  const { dir, msg } = JSON.parse(line);
  if (dir !== 'in' && dir !== 'out') continue;
  if (DROP.has(msg.method)) continue;
  delete msg.emittedAtMs;
  if (Array.isArray(msg.result?.data) && msg.result.data[0]?.supportedReasoningEfforts) msg.result.data = msg.result.data.slice(0, 2);
  for (const entry of msg.result?.data ?? []) if (Array.isArray(entry?.skills)) entry.skills = entry.skills.filter((skill) => skill.scope === 'repo');
  // The account's own connectors list its linked profiles and plugins: only their shape is kept.
  for (const entry of msg.result?.data ?? []) if (typeof entry?.httpOrigin === 'string') Object.assign(entry, { tools: {}, resources: [] });
  out.push(scrub(JSON.stringify({ dir, msg })));
}
// Nothing is written while a line still names the owner, a path of this machine or a secret; the report names the line, never the value.
const leaks = out.flatMap((line, index) => DENY.filter(([, pattern]) => pattern.test(line)).map(([label]) => `${to}: line ${index + 1}: ${label}`));
if (leaks.length > 0) {
  console.error([...new Set(leaks)].join('\n'));
  process.exit(1);
}
writeFileSync(to, `${out.join('\n')}\n`);
