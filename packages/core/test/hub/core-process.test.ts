import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { spawnCore } from '../../src/hub/core-process';
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
