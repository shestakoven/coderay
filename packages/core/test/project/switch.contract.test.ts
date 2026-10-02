import { describe, expect, it } from 'vitest';
import { projectDir } from '../../src/home';
import { acquireCoreLock } from '../../src/lock';
import { projectBusy, successorArgs } from '../../src/project/switch';
import { tempDir } from '../helpers';

const count = (args: string[], flag: string): number => args.filter((a) => a === flag).length;
const valueOf = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

describe('successorArgs for a launcher successor (newRoot null)', () => {
  it('drops --project and its value and keeps the other arguments in order', () => {
    const argv = ['--ide-home', '/h', '--project', '/old', '--port', '0', '--ui', '/ui/dist', '--claude', '/bin/claude'];
    expect(successorArgs(argv, null, 4317)).toEqual(['--ide-home', '/h', '--ui', '/ui/dist', '--claude', '/bin/claude', '--port', '4317']);
  });

  it('drops every --project pair when given more than once', () => {
    const args = successorArgs(['--project', '/a', '--x', '--project', '/b'], null, 1);
    expect(args).not.toContain('--project');
    expect(args).not.toContain('/a');
    expect(args).not.toContain('/b');
    expect(args).toContain('--x');
  });

  it('keeps an argument equal to the old project path when it belongs to another flag', () => {
    expect(successorArgs(['--ui', '/same', '--project', '/same'], null, 9)).toEqual(['--ui', '/same', '--port', '9']);
  });

  it('adds no --project when the launcher itself had none', () => {
    expect(successorArgs(['--ide-home', '/h', '--port', '0'], null, 5000)).toEqual(['--ide-home', '/h', '--port', '5000']);
  });

  it('replaces the port with the bound one, exactly once', () => {
    const args = successorArgs(['--port', '0', '--port', '7'], null, 61000);
    expect(count(args, '--port')).toBe(1);
    expect(valueOf(args, '--port')).toBe('61000');
    expect(args).not.toContain('0');
    expect(args).not.toContain('7');
  });

  it('drops --token-stdin so the token never depends on argv', () => {
    expect(successorArgs(['--token-stdin', '--project', '/old'], null, 3)).toEqual(['--port', '3']);
  });

  it('does not mutate its input', () => {
    const argv = ['--project', '/old', '--port', '0'];
    successorArgs(argv, null, 1);
    expect(argv).toEqual(['--project', '/old', '--port', '0']);
  });
});

describe('successorArgs for a project successor', () => {
  it('replaces the old project with the new one, exactly once', () => {
    const args = successorArgs(['--project', '/old', '--ide-home', '/h', '--port', '0'], '/new', 4317);
    expect(count(args, '--project')).toBe(1);
    expect(valueOf(args, '--project')).toBe('/new');
    expect(args).not.toContain('/old');
    expect(valueOf(args, '--ide-home')).toBe('/h');
    expect(valueOf(args, '--port')).toBe('4317');
  });

  it('adds --project to the arguments of a launcher that had none', () => {
    expect(successorArgs(['--ide-home', '/h', '--port', '0'], '/created', 8)).toEqual(['--ide-home', '/h', '--project', '/created', '--port', '8']);
  });

  it('passes a project path with spaces as one argument', () => {
    const args = successorArgs([], '/Users/me/My Projects/app', 2);
    expect(valueOf(args, '--project')).toBe('/Users/me/My Projects/app');
  });
});

describe('projectBusy', () => {
  it('is null for a project no core holds', () => {
    const home = tempDir('ide-home-');
    expect(projectBusy(home, tempDir('ide-proj-'))).toBeNull();
  });

  it('names the problem while a live core holds the project lock', () => {
    const home = tempDir('ide-home-');
    const root = tempDir('ide-proj-');
    const lock = acquireCoreLock(projectDir(home, root));
    try {
      expect(projectBusy(home, root)).toEqual(expect.any(String));
    } finally {
      lock.release();
    }
  });

  it('is null again after the holder released the lock', () => {
    const home = tempDir('ide-home-');
    const root = tempDir('ide-proj-');
    acquireCoreLock(projectDir(home, root)).release();
    expect(projectBusy(home, root)).toBeNull();
  });
});
