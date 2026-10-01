import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { successorArgs, validateProjectPath } from '../../src/project/switch';
import { tempDir } from '../helpers';

describe('successorArgs', () => {
  it('appends the new project and port', () => {
    expect(successorArgs([], '/new', 4318)).toEqual(['--project', '/new', '--port', '4318']);
  });

  it('removes --project and --port in the separate-value form', () => {
    expect(successorArgs(['--project', '/old', '--port', '4317'], '/new', 1)).toEqual(['--project', '/new', '--port', '1']);
  });

  it('removes --project and --port in the = form', () => {
    expect(successorArgs(['--project=/old', '--port=4317'], '/new', 1)).toEqual(['--project', '/new', '--port', '1']);
  });

  it('removes every occurrence of each flag', () => {
    const argv = ['--project', '/a', '--port', '1', '--project=/b', '--port=2'];
    expect(successorArgs(argv, '/new', 3)).toEqual(['--project', '/new', '--port', '3']);
  });

  it('keeps the other flags with their values in the original order', () => {
    const argv = ['--ui', 'dist', '--project', '/old', '--allow-origin', 'http://x', '--ide-home', '/h', '--port=9', '--claude', '/bin/claude'];
    expect(successorArgs(argv, '/new', 5)).toEqual([
      '--ui', 'dist', '--allow-origin', 'http://x', '--ide-home', '/h', '--claude', '/bin/claude', '--project', '/new', '--port', '5',
    ]);
  });

  it('keeps a value that merely resembles a dropped flag when it follows another flag', () => {
    expect(successorArgs(['--ui', '--project-x'], '/n', 1)).toEqual(['--ui', '--project-x', '--project', '/n', '--port', '1']);
  });

  it('does not drop the argument after --port= (value is inline)', () => {
    expect(successorArgs(['--port=1', '--ui', 'dist'], '/n', 2)).toEqual(['--ui', 'dist', '--project', '/n', '--port', '2']);
  });

  it('never inserts an auth token', () => {
    const joined = successorArgs(['--ui', 'dist'], '/n', 1).join(' ');
    expect(joined).not.toMatch(/token/i);
  });

  it('does not mutate the input argv', () => {
    const argv = ['--project', '/old'];
    successorArgs(argv, '/new', 1);
    expect(argv).toEqual(['--project', '/old']);
  });
});

describe('validateProjectPath', () => {
  it('rejects a relative path with a message', () => {
    const result = validateProjectPath('some/relative');
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).not.toBe('');
  });

  it('rejects a relative path even when it resolves to an existing folder', () => {
    expect(validateProjectPath('.')).toHaveProperty('error');
    expect(validateProjectPath('..')).not.toHaveProperty('root');
  });

  it('rejects a missing folder with a message', () => {
    const root = tempDir('ide-switch-');
    const result = validateProjectPath(join(root, 'missing'));
    expect(result).not.toHaveProperty('root');
    expect((result as { error: string }).error).not.toBe('');
  });

  it('rejects a file with a message', () => {
    const root = tempDir('ide-switch-');
    writeFileSync(join(root, 'f'), 'x');
    const result = validateProjectPath(join(root, 'f'));
    expect(result).not.toHaveProperty('root');
    expect((result as { error: string }).error).not.toBe('');
  });

  it('uses different messages for a missing path and for a file', () => {
    const root = tempDir('ide-switch-');
    writeFileSync(join(root, 'f'), 'x');
    expect(validateProjectPath(join(root, 'f'))).not.toEqual(validateProjectPath(join(root, 'missing')));
  });

  it('accepts a directory and returns its root', () => {
    const root = tempDir('ide-switch-');
    expect(validateProjectPath(root)).toEqual({ root });
  });

  it('resolves a symlink to the real path', () => {
    const root = tempDir('ide-switch-');
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    expect(validateProjectPath(join(root, 'link'))).toEqual({ root: join(root, 'real') });
  });

  it('rejects a symlink pointing to a file', () => {
    const root = tempDir('ide-switch-');
    writeFileSync(join(root, 'f'), 'x');
    symlinkSync(join(root, 'f'), join(root, 'link'));
    expect(validateProjectPath(join(root, 'link'))).toHaveProperty('error');
  });
});
