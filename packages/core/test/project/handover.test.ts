import { afterEach, describe, expect, it } from 'vitest';
import { takeNodeLauncher } from '../../src/node-exec';
import { spawnSuccessor } from '../../src/project/handover';
import { recordingLauncher, waitFor } from '../helpers';

afterEach(() => takeNodeLauncher({}));

describe('spawnSuccessor', () => {
  it('starts the successor core on the taken launcher, passing it on as IDE_NODE with the rest of the environment', async () => {
    const launcher = recordingLauncher();
    takeNodeLauncher({ IDE_NODE: launcher.path });
    await spawnSuccessor(['--project', '/work/app', '--port', '4401'], 'token');
    const ran = await waitFor(launcher.ran, 'the launcher to run', 5000);
    expect([ran.argv[0], ...ran.argv.slice(-5)]).toEqual([launcher.path, '--project', '/work/app', '--port', '4401', '--token-stdin']);
    expect([ran.ideNode, ran.home]).toEqual([launcher.path, process.env.HOME ?? 'unset']);
  });
});
