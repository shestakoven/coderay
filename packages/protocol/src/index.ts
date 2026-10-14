import type { GitClientMessage, GitServerMessage } from './git';
import type { HistoryClientMessage, HistoryServerMessage } from './history';
import type { HubClientMessage, HubServerMessage } from './hub';
import type { PlanClientMessage, PlanServerMessage } from './plans';
import type { ProjectClientMessage, ProjectServerMessage } from './project';
import type { TerminalClientMessage, TerminalServerMessage } from './terminal';
import type { ChatClientMessage, SessionServerMessage } from './session';
import type { SettingsClientMessage, SettingsServerMessage } from './settings';

export * from './session';
export * from './engines';
export * from './settings';
export * from './plans';
export * from './history';
export * from './review';
export * from './git';
export * from './hub';
export * from './project';
export * from './project-name';
export * from './terminal';

export type Lang = 'typescript' | 'python' | 'c' | 'cpp' | 'csharp' | 'swift';

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

export type ContainerRole = 'ui' | 'api' | 'worker' | 'service';

export type ExternalKind = 'database' | 'broker' | 'storage' | 'ai' | 'search' | 'documents' | 'email' | 'cache' | 'ml' | 'source' | 'other';

export interface C4Evidence {
  path: string;
  note: string;
}

export interface C4ContainerComponent {
  id: string;
  files: number;
  near: number;
  containers: number;
}

export interface C4ComponentLink {
  from: string;
  to: string;
  count: number;
}

export interface C4Container {
  id: string;
  name: string;
  role: ContainerRole;
  tech: string;
  launch: string[];
  entryFiles: string[];
  entryMissing: string[];
  files: number;
  components: C4ContainerComponent[];
  componentLinks: C4ComponentLink[];
  group: string | null;
  evidence: C4Evidence[];
}

export interface C4External {
  id: string;
  name: string;
  kind: ExternalKind;
  identifiers: string[];
}

export interface C4Link {
  id: string;
  from: string;
  to: string;
  protocol: string;
  strength: number;
  evidence: C4Evidence[];
}

export interface C4Model {
  containers: C4Container[];
  externals: C4External[];
  links: C4Link[];
  tooling: string[];
  warnings: string[];
}

export type OverviewLane = 'interface' | 'core' | 'integrations' | 'platform' | 'noise';

export interface OverviewPart {
  id: string;
  name: string;
  summary: string;
  files: number;
  dirs: string[];
  noise: boolean;
}

export interface OverviewComponent {
  id: string;
  name: string;
  role: string;
  files: number;
  langs: string[];
  noise: boolean;
  parts: OverviewPart[];
}

export interface OverviewGroup {
  id: string;
  name: string;
  summary: string;
  lane: OverviewLane;
  noise: boolean;
  files: number;
  components: OverviewComponent[];
}

// Imports between parts (from imports to); the UI sums them up to whatever level is open.
export interface OverviewLink {
  from: string;
  to: string;
  count: number;
}

export interface OverviewLabel {
  from: string;
  to: string;
  label: string;
}

export interface MapOverview {
  state: 'waiting' | 'running' | 'ready' | 'failed';
  error: string | null;
  basedOnCurrentMap: boolean;
  groups: OverviewGroup[];
  links: OverviewLink[];
  labels: OverviewLabel[];
}

export interface MapSnapshot {
  version: number;
  projectName: string;
  files: MapFile[];
  components: MapComponent[];
  fileEdges: FileEdge[];
  status: MapStatus;
  c4?: C4Model;
  overview?: MapOverview;
}

export interface MapProgress {
  indexing: { indexed: number } | null;
  embedding: { done: number; total: number } | null;
}

export type ServerMessage =
  | { type: 'map.snapshot'; snapshot: MapSnapshot }
  | { type: 'map.progress'; progress: MapProgress }
  | SessionServerMessage
  | SettingsServerMessage
  | PlanServerMessage
  | HistoryServerMessage
  | GitServerMessage
  | ProjectServerMessage
  | HubServerMessage
  | TerminalServerMessage;

export type ClientMessage =
  | ChatClientMessage
  | SettingsClientMessage
  | PlanClientMessage
  | HistoryClientMessage
  | GitClientMessage
  | ProjectClientMessage
  | HubClientMessage
  | TerminalClientMessage
  | { type: 'map.regroup' }
  | { type: 'map.overview' };
