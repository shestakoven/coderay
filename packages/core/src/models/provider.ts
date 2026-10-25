import { join } from 'node:path';
import { BackgroundAi, BackgroundAiStore, type BackgroundAiOptions } from './background-ai';
import { LocalEmbedModel } from './local-embed';
import type { ModelProvider } from './types';

export interface DefaultModelProvider extends ModelProvider {
  close(): Promise<void>;
}

export function createModelProvider(options: Omit<BackgroundAiOptions, 'embed' | 'store'> & { home: string }): BackgroundAi {
  const { home, ...rest } = options;
  return new BackgroundAi({ ...rest, embed: new LocalEmbedModel({ cacheDir: join(home, 'models') }), store: new BackgroundAiStore(home) });
}
