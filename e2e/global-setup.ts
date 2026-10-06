import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LocalEmbedModel } from '../packages/core/src/models/local-embed';
import { MODELS_CACHE } from './core';

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

// Every core a test starts loads the embedding model. With an empty cache (a fresh checkout or worktree) each one starts
// a 34 MB download that the test stops a second later, and a core stopped mid-download can hang its shutdown.
export default async function globalSetup(): Promise<void> {
  const model = new LocalEmbedModel({ cacheDir: MODELS_CACHE });
  try {
    if (model.status().state === 'downloading') console.log('e2e: downloading the embedding model once for every test core…');
    const state = await new Promise<string>((resolve) => {
      const settled = (): boolean => {
        const status = model.status();
        if (status.state !== 'ready' && status.state !== 'unavailable') return false;
        resolve(status.state === 'ready' ? 'ready' : status.reason);
        return true;
      };
      if (!settled()) model.onStatus(() => void settled());
      setTimeout(() => resolve('timed out'), DOWNLOAD_TIMEOUT_MS).unref();
    });
    if (state !== 'ready') throw new Error(`e2e: the embedding model is not available (${state})`);
  } finally {
    await model.close();
  }
  removePartialDownloads(MODELS_CACHE);
}

// A core stopped mid-download leaves its temporary file behind.
function removePartialDownloads(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.includes('.tmp.')) rmSync(join(entry.parentPath, entry.name), { force: true });
  }
}
