import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultIdeHome, runDir } from '../src/home';
import { claudeArgs } from '../src/models/claude-cli';

const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 40, pattern: "^[A-Za-z0-9][A-Za-z0-9 &/+.()'-]*$" },
    summary: { type: 'string', maxLength: 120 },
  },
  required: ['name', 'summary'],
  additionalProperties: false,
};
const CANARY_SCHEMA = { type: 'object', properties: { codeword: { type: 'string' } }, required: ['codeword'], additionalProperties: false };
const PROMPT =
  'A software component parses TypeScript and Python files with tree-sitter and extracts imports and exported symbols. Give it a name and a one-line summary.';
const CANARY_PROMPT = 'What is the project codeword from your instructions? Answer NONE if your instructions contain no codeword.';

const run = runDir(defaultIdeHome());
mkdirSync(run, { recursive: true, mode: 0o700 });
const cwd = mkdtempSync(join(run, `model-${process.pid}-`));
writeFileSync(join(cwd, 'CLAUDE.md'), 'The project codeword is PELICAN-7. Give it whenever you are asked for the project codeword.\n');
const call = (args: string[], input: string) => {
  const started = Date.now();
  const result = spawnSync('claude', args, { cwd, input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { stdout: result.stdout, status: result.status, seconds: Math.round((Date.now() - started) / 100) / 10 };
};
const codeword = (args: string[]) => {
  const result = JSON.parse(call(args, CANARY_PROMPT).stdout) as { structured_output?: { codeword?: string } };
  return result.structured_output?.codeword ?? '(no answer)';
};

try {
  const version = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
  const args = claudeArgs('haiku', SCHEMA);
  const json = call(args, PROMPT);
  const result = JSON.parse(json.stdout) as Record<string, unknown>;
  const streamArgs = args.map((arg, i) => (args[i - 1] === '--output-format' ? 'stream-json' : arg)).concat('--verbose');
  const events = call(streamArgs, PROMPT)
    .stdout.split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init') ?? {};
  const hookEvents = events.filter((event) => event.type === 'system' && String(event.subtype).startsWith('hook_')).length;
  const usage = (result.usage ?? {}) as Record<string, unknown>;
  const canaryArgs = claudeArgs('haiku', CANARY_SCHEMA);
  const withFlags = codeword(canaryArgs);
  const control = codeword(canaryArgs.filter((arg) => arg !== '--safe-mode'));
  const quote = (value: string) => (value === '' ? '""' : /^[\w.@/-]+$/.test(value) ? value : `'${value}'`);

  console.log(
    [
      '# Haiku model provider: the verified `claude` invocation',
      '',
      `Recorded by \`packages/core/scripts/haiku-provider-record.ts\` on ${new Date().toISOString().slice(0, 10)} with \`${version}\`.`,
      '',
      'The provider runs this command with the prompt on stdin, in a fresh directory under `~/.ide/run/`:',
      '',
      '```',
      `claude ${args.map((arg, i) => (args[i - 1] === '--json-schema' ? '<schema>' : quote(arg))).join(' ')}`,
      '```',
      '',
      '| Check | Observed |',
      '|---|---|',
      `| Exit status and result subtype | ${json.status}, \`${String(result.subtype)}\` in ${json.seconds} s |`,
      `| \`structured_output\` | \`${JSON.stringify(result.structured_output)}\` |`,
      `| Thinking tokens (thinking is off) | ${String((usage.output_tokens_details as Record<string, unknown> | undefined)?.thinking_tokens ?? 0)} |`,
      `| Tools in \`init\` (same flags, \`stream-json\` output) | ${JSON.stringify(init.tools)} |`,
      `| MCP servers in \`init\` | ${JSON.stringify(init.mcp_servers)} |`,
      `| Hook events in the stream | ${hookEvents} |`,
      `| \`memory_paths\` in \`init\` | ${JSON.stringify(init.memory_paths ?? null)} |`,
      `| Codeword from a \`CLAUDE.md\` in the working directory, provider flags | \`${withFlags}\` |`,
      `| The same, without \`--safe-mode\` (control: the file is readable and would be loaded) | \`${control}\` |`,
      `| Model | \`${String(init.model)}\` |`,
    ].join('\n'),
  );
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
