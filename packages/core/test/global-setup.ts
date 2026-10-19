import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every XDG home of a test run is its own: nothing a test starts (opencode, git) reads or writes the owner's.
export default function setup(): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'coderay-xdg-'));
  for (const name of ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) process.env[name] = join(dir, name.toLowerCase());
  return () => rmSync(dir, { recursive: true, force: true });
}
