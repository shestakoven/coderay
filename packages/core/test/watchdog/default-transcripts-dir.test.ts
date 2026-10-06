import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultTranscriptsDir, transcriptPath } from '../../src/watchdog/recovery';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('defaultTranscriptsDir', () => {
  it('is the projects folder of ~/.claude when CLAUDE_CONFIG_DIR is not set', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    expect(defaultTranscriptsDir()).toBe(join(homedir(), '.claude', 'projects'));
  });

  it('is the projects folder of CLAUDE_CONFIG_DIR when it is set', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/work/claude-config');
    expect(defaultTranscriptsDir()).toBe(join('/work/claude-config', 'projects'));
  });

  it('takes an empty CLAUDE_CONFIG_DIR for none at all', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    expect(defaultTranscriptsDir()).toBe(join(homedir(), '.claude', 'projects'));
  });

  it('reads the variable at the moment it is asked, not when the module was loaded', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/first');
    expect(defaultTranscriptsDir()).toBe(join('/first', 'projects'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/second');
    expect(defaultTranscriptsDir()).toBe(join('/second', 'projects'));
  });

  it('is where the transcript of a conversation is looked for', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/work/claude-config');
    expect(transcriptPath(defaultTranscriptsDir(), '/work/project', 'abc')).toBe(join('/work/claude-config', 'projects', '-work-project', 'abc.jsonl'));
  });
});
