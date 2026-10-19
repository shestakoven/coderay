import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { childCoreArgs, spawnCore } from '../../src/hub/core-process';
import { takeNodeLauncher } from '../../src/node-exec';
import { recordingLauncher, waitFor } from '../helpers';

afterEach(() => takeNodeLauncher({}));

describe('spawnCore', () => {
  it('starts the child core on the taken launcher, passing it on as IDE_NODE with the rest of the environment', async () => {
    const launcher = recordingLauncher();
    takeNodeLauncher({ IDE_NODE: launcher.path });
    const child = spawnCore(['--project', '/work/app', '--port', '4401'], 'token', 'app');
    onTestFinished(() => child.kill('SIGKILL'));
    const ran = await waitFor(launcher.ran, 'the launcher to run', 5000);
    expect([ran.argv[0], ...ran.argv.slice(-4)]).toEqual([launcher.path, '--project', '/work/app', '--port', '4401']);
    expect([ran.ideNode, ran.home]).toEqual([launcher.path, process.env.HOME ?? 'unset']);
  });
});

describe('childCoreArgs', () => {
  it('hands each project core the codex and the opencode the hub was given, or none, so a test hub never starts the real ones', () => {
    const target = { root: '/work/app', port: 4401, home: '/h', hubPort: 4317 };
    const flags = { claude: '/bin/claude', noMapMcp: false, noAgentSearch: false, allowedOrigins: [] };
    const engines = (args: string[]) => args.filter((arg, at) => /^--(no-)?(codex|opencode)$/.test(arg) || /^--(codex|opencode)$/.test(args[at - 1] ?? ''));
    expect([engines(childCoreArgs(target, { ...flags, codex: null, opencode: null })), engines(childCoreArgs(target, { ...flags, codex: '/opt/codex', opencode: '/opt/opencode' }))]).toEqual([
      ['--no-codex', '--no-opencode'], ['--codex', '/opt/codex', '--opencode', '/opt/opencode'],
    ]);
  });
});
