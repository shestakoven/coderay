import { claudeEnv, spawnClaude } from '../../src/agent/claude-process';

const [fake, scenario, recordFile, cwd, pidDir] = process.argv.slice(2);
const command = { command: process.execPath, args: [fake ?? ''], env: { FAKE_CLAUDE_SCENARIO: scenario ?? '', FAKE_CLAUDE_RECORD: recordFile ?? '' } };
spawnClaude(command.command, command.args, cwd ?? '.', claudeEnv(command), { pidDir });
setInterval(() => {}, 60_000);
