import { readFileSync } from 'node:fs';
import { startClaude } from '../../src/agent/claude-process';

const [fakeClaude, scenario, recordFile, cwd] = process.argv.slice(2);
startClaude(
  { command: process.execPath, args: [fakeClaude ?? ''], env: { FAKE_CLAUDE_SCENARIO: scenario ?? '', FAKE_CLAUDE_RECORD: recordFile ?? '' } },
  [], cwd ?? '.', () => {},
);
const ready = setInterval(() => {
  let records = '';
  try {
    records = readFileSync(recordFile ?? '', 'utf8');
  } catch {
    return;
  }
  if (!records.includes('keepsRunning')) return;
  clearInterval(ready);
  process.exit(1);
}, 20);
