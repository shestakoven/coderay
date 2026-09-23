import type { Lang, MapSymbol } from '@ide/protocol';

export interface ParsedFile {
  imports: string[];
  symbols: MapSymbol[];
  parseError: boolean;
}

export interface LanguageAdapter {
  readonly lang: Lang;
  handles(path: string): boolean;
  parse(path: string, source: string): ParsedFile;
  resolve(fromPath: string, specifier: string, exists: (path: string) => boolean): string | null;
}
