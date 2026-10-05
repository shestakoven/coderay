import { join } from 'node:path';
import { runDir } from '../home';
import { ClaudeCliModel } from './claude-cli';
import { LocalEmbedModel } from './local-embed';
import type { ModelProvider } from './types';

export interface DefaultModelProvider extends ModelProvider {
  close(): Promise<void>;
}

export function createModelProvider(home: string, env?: () => Record<string, string>): DefaultModelProvider {
  const haiku = new ClaudeCliModel({ model: 'haiku', runDir: runDir(home), env });
  const embed = new LocalEmbedModel({ cacheDir: join(home, 'models') });
  return { reasoning: haiku, fast: haiku, embed, close: () => embed.close() };
}
