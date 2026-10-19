import { startServer } from '../../src/agent/opencode/server';
import { fakeOpencode, opencodeRecords } from './fake';

// A core that exits without stopping its opencode while the model's shell command runs.
const [scenario, recordFile, cwd] = process.argv.slice(2);
const server = startServer(fakeOpencode(scenario ?? null, recordFile ?? ''), { cwd: cwd ?? '.' });
const { client } = await server.ready;
const session = await client.post<{ id: string }>('/session', {});
await client.post(`/session/${session.id}/prompt_async`, { parts: [{ type: 'text', text: 'go' }] });
const running = setInterval(() => {
  if (!opencodeRecords(recordFile ?? '').some((entry) => entry.sleeperPid !== undefined)) return;
  clearInterval(running);
  process.exit(1);
}, 20);
