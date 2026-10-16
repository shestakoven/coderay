// Copies a verification transcript of `codex app-server` with paths, ids and account details replaced, as provenance for the fake's fixtures.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';

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
const DROP = new Set(['remoteControl/status/changed']);
const scrub = (text) => text
  .replaceAll(project, '$CWD').replaceAll(homedir(), '$HOME').replaceAll(userInfo().username, 'owner')
  .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, 'owner@example.com')
  .replace(/cf-ray: [\w-]+/g, 'cf-ray: …').replace(/req_[0-9a-f]{16,}/g, 'req_…')
  .replace(/"(chatgptAccountId|installationId|serverName|environmentId|backendOrigin|sha|originUrl)":"[^"]*"/g, '"$1":"…"')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => idOf('id', id))
  .replace(/\b(msg|rs)_[0-9a-f]{16,}\b/g, (id, kind) => idOf(kind, id));
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
writeFileSync(to, `${out.join('\n')}\n`);
