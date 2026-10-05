import type { Lang, MapSymbol } from '@ide/protocol';

export interface ParsedFile {
  imports: string[];
  symbols: MapSymbol[];
  parseError: boolean;
  provides?: string[];
}

export interface LanguageAdapter {
  readonly lang: Lang;
  handles(path: string): boolean;
  parse(path: string, source: string): ParsedFile;
  resolve(fromPath: string, specifier: string, exists: (path: string) => boolean): string | null;
  // For languages that import a namespace or module by name (C#, Swift): `provides` of a file is the names it declares.
  resolveAll?(specifier: string, providers: (name: string) => string[]): string[];
}
