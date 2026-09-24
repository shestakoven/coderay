import type { Lang, MapSymbol } from '@ide/protocol';

export interface IndexedFile {
  path: string;
  lang: Lang;
  contentHash: string;
  imports: string[];
  symbols: MapSymbol[];
  parseError: boolean;
}
