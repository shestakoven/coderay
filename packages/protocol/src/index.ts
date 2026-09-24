export type Lang = 'typescript' | 'python';

export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable';

export interface MapSymbol {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface MapFile {
  path: string;
  lang: Lang;
  componentId: string | null;
  symbols: MapSymbol[];
  parseError: boolean;
}

export type ComponentSource = 'ai' | 'manual' | 'folder';

export interface MapComponent {
  id: string;
  name: string;
  description: string;
  files: string[];
  globs: string[];
  source: ComponentSource;
  stale: boolean;
}

export interface FileEdge {
  from: string;
  to: string;
  kind: 'import';
}

export interface MapSnapshot {
  version: number;
  projectName: string;
  files: MapFile[];
  components: MapComponent[];
  fileEdges: FileEdge[];
}

export type ServerMessage = { type: 'map.snapshot'; snapshot: MapSnapshot };
