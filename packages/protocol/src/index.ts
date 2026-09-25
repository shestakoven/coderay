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
  manualAssignment: boolean;
  symbols: MapSymbol[];
  parseError: boolean;
}

export type ComponentSource = 'ai' | 'manual' | 'folder';

export interface MapComponent {
  id: string;
  name: string;
  summary: string;
  description: string;
  files: string[];
  keyFiles: string[];
  globs: string[];
  source: ComponentSource;
  stale: boolean;
}

export interface FileEdge {
  from: string;
  to: string;
  kind: 'import';
}

export type GroupingState = 'idle' | 'running' | 'failed' | 'too-large';

export interface GroupingPayload {
  paths: number;
  symbols: number;
  links: number;
}

export type EmbeddingsState = 'loading' | 'downloading' | 'ready' | 'unavailable';

export interface EmbeddingPlacement {
  on: boolean;
  detail: string;
}

export interface MapStatus {
  layer: 'folder' | 'ai';
  grouping: GroupingState;
  groupingError: string | null;
  groupedAt: string | null;
  stale: boolean;
  staleReasons: string[];
  unassigned: number;
  pending: number;
  sending: GroupingPayload | null;
  embeddings: EmbeddingsState;
  embeddingsError: string | null;
  embeddingPlacement: EmbeddingPlacement | null;
  modelDownloadBytes: number | null;
  warnings: string[];
}

export interface MapSnapshot {
  version: number;
  projectName: string;
  files: MapFile[];
  components: MapComponent[];
  fileEdges: FileEdge[];
  status: MapStatus;
}

export type ServerMessage = { type: 'map.snapshot'; snapshot: MapSnapshot };
