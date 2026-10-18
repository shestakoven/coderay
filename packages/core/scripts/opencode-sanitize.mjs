// Copies a verification transcript of `opencode serve` with paths, ids, keys and the user name replaced, as provenance for the fake's fixtures.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';

const [from, to, ...roots] = process.argv.slice(2);
if (!from || !to) {
  console.error('usage: node opencode-sanitize.mjs <transcript.jsonl> <out.jsonl> [<scratch dir>…]');
  process.exit(2);
}
const ids = new Map();
const idOf = (kind, value) => {
  if (!ids.has(value)) ids.set(value, `${kind}-${[...ids.values()].filter((id) => id.startsWith(`${kind}-`)).length + 1}`);
  return ids.get(value);
};
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DROP = new Set(['server.heartbeat', 'server.connected']);
const scratch = [...roots, tmpdir(), realpathSync(tmpdir())].flatMap((root) => [root, root.replace(/^\/private/, '')]).sort((a, b) => b.length - a.length);
// macOS temp paths the roots miss: one a model mangled (`…gn_T/…`), and one written relative to `/` (a non-git project's worktree).
const MAC_TMP = /\/?(?:private\/)?var\/folders\/\w+\/\w+[/_]T(?=[/"\\])/g;
const scrub = (text) => scratch.reduce((out, root) => out.replaceAll(root, '$TMP'), text.replace(MAC_TMP, (path) => (path.startsWith('/') ? '$TMP' : '$TMP_FROM_ROOT')))
  .replaceAll(homedir(), '$HOME').replaceAll(userInfo().username, 'owner')
  .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-…').replace(/Bearer [^"\s]+/g, 'Bearer …').replace(/"key":"[^"]*"/g, '"key":"…"').replace(/opencode:probe/g, 'opencode:…')
  .replace(/OPENCODE_SERVER_PASSWORD=[^\s"\\]+/g, 'OPENCODE_SERVER_PASSWORD=…')
  // The owner's own skills (under ~/.agents/skills) are named by a counter: their names and texts are not the fixtures' business.
  .replace(/\$HOME\/\.agents\/skills\/([^/"\\]+)/g, (_, skill) => `$HOME/.agents/skills/${idOf('skill', skill)}`)
  .replace(/\b(ses|msg|prt|per|que|tool)_[0-9A-Za-z]{10,}\b/g, (id, kind) => idOf(kind, id));
const cut = (text, n) => (typeof text === 'string' && text.length > n ? `${text.slice(0, n)}…` : text);
const KEPT_SKILLS = new Set(['customize-opencode', 'hostile-skill', 'hostile-claude-skill']);

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
  ['a home or scratch path', /\/Users\/|\/home\/|\/var\/folders\/|\/tmp\/claude-\d+/],
  ['a credential', /\bsk-[\w-]{8,}|Bearer t0k|opencode:probe|OPENCODE_SERVER_PASSWORD=(?!…)/],
];

const sameDelta = (a, b) => ['sessionID', 'messageID', 'partID', 'field'].every((key) => a?.properties?.[key] === b?.properties?.[key]);
const items = [];
let plugins = 0;
for (const line of readFileSync(from, 'utf8').split('\n')) {
  if (line.trim() === '') continue;
  const { dir, msg } = JSON.parse(line);
  if (dir === 'sse' && DROP.has(msg?.type)) continue;
  // Every boot announces its ~45 built-in plugins: a few show the shape, a file plugin is always kept.
  if (dir === 'sse' && msg?.type === 'plugin.added' && ++plugins > 6 && !/[./]|hostile|global/.test(msg.properties?.id ?? '')) continue;
  // Adjacent deltas of one part become one frame: the stream's shape stays, its word-by-word bulk goes.
  const last = items.at(-1);
  if (dir === 'sse' && msg?.type === 'message.part.delta' && last?.dir === 'sse' && last.msg?.type === 'message.part.delta' && sameDelta(last.msg, msg)) {
    last.msg.properties.delta += msg.properties.delta;
    continue;
  }
  if (dir === 'res' && msg.path === '/config/providers' && Array.isArray(msg.body?.providers)) {
    msg.body.providers = msg.body.providers.slice(0, 2).map((provider) => ({ ...provider, models: Object.fromEntries(Object.entries(provider.models ?? {}).sort(([a], [b]) => Number(b === 'nemotron-3.5-lightning-free') - Number(a === 'nemotron-3.5-lightning-free')).slice(0, 2)) }));
  }
  if (dir === 'res' && msg.path === '/provider') msg.body = { trimmed: true };
  if (dir === 'res' && msg.path === '/command' && Array.isArray(msg.body)) {
    msg.body = msg.body.filter((entry) => entry.source !== 'skill' || KEPT_SKILLS.has(entry.name)).map((entry) => ({ ...entry, template: cut(entry.template, 400) }));
  }
  if (dir === 'res' && msg.path === '/agent' && Array.isArray(msg.body)) {
    for (const agent of msg.body) {
      agent.prompt = cut(agent.prompt, 200);
      // 1.19 allows each of the user's ~/.agents/skills directories by name: two show the rule.
      let skills = 0;
      if (Array.isArray(agent.permission)) agent.permission = agent.permission.filter((rule) => !String(rule.pattern).includes('/.agents/skills/') || ++skills <= 2);
    }
  }
  items.push({ dir, msg });
}
// Repeated snapshots of one session, message or part only grow it: a session keeps its first, a message or a reasoning part
// its last (completed) one, a text part its first and last, a tool part the first of each state (its input is in `running`).
const snapshot = ({ dir, msg }) => {
  if (dir !== 'sse') return undefined;
  const p = msg.properties ?? {};
  if (msg.type === 'session.updated' || msg.type === 'session.diff') return [`${msg.type}:${p.info?.id ?? p.sessionID}`, 'first'];
  if (msg.type === 'message.updated') return [`message:${p.info?.id}`, 'last'];
  if (msg.type === 'message.part.updated' && p.part?.type === 'reasoning') return [`part:${p.part.id}`, 'last'];
  if (msg.type === 'message.part.updated' && p.part?.type === 'text') return [`part:${p.part.id}`, 'both'];
  if (msg.type === 'message.part.updated' && p.part?.type === 'tool') return [`part:${p.part.id}:${p.part.state?.status}`, 'first'];
  return undefined;
};
const firstAt = new Map();
const lastAt = new Map();
items.forEach((item, index) => { const [key] = snapshot(item) ?? []; if (key === undefined) return; if (!firstAt.has(key)) firstAt.set(key, index); lastAt.set(key, index); });
const kept = items.filter((item, index) => {
  const [key, keep] = snapshot(item) ?? [];
  if (key === undefined) return true;
  return (keep !== 'last' && firstAt.get(key) === index) || (keep !== 'first' && lastAt.get(key) === index);
});
// Long prose (a model's reasoning, a tool's output) is cut: its shape is what the fixtures need, not its length.
for (const { dir, msg } of kept) {
  if (dir !== 'sse') continue;
  if (msg.type === 'message.part.delta') msg.properties.delta = cut(msg.properties.delta, 300);
  const part = msg.type === 'message.part.updated' ? msg.properties.part : undefined;
  if (part?.type === 'reasoning') part.text = cut(part.text, 300);
  if (part?.type === 'tool' && part.state) {
    part.state.output = cut(part.state.output, 600);
    if (part.state.metadata) part.state.metadata.output = cut(part.state.metadata.output, 600);
  }
}
const out = kept.map((item) => scrub(JSON.stringify(item)));
// Nothing is written while a line still names the owner, a path of this machine or a secret; the report names the line, never the value.
const leaks = out.flatMap((line, index) => DENY.filter(([, pattern]) => pattern.test(line)).map(([label]) => `${to}: line ${index + 1}: ${label}`));
if (leaks.length > 0) {
  console.error([...new Set(leaks)].join('\n'));
  process.exit(1);
}
writeFileSync(to, `${out.join('\n')}\n`);
