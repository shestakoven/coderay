export type McpLevel = 'ide' | 'project';
export type McpTransport = 'stdio' | 'http';

export interface McpEntry {
  type: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
}

export type McpServerStatus = 'ready' | 'unapproved' | 'missing-env' | 'shadowed';

export interface McpServerView {
  name: string;
  level: McpLevel;
  entry: McpEntry;
  entryHash: string;
  status: McpServerStatus;
  reason: string | null;
}

export interface FileHashes {
  ideServers: string;
  trust: string;
}

export interface SettingsView {
  servers: McpServerView[];
  problems: string[];
  fileHashes: FileHashes;
  externalEdits: { ideServers: boolean; trust: boolean; trustApproves: string[] };
}

export type SettingsServerMessage =
  | { type: 'settings.snapshot'; settings: SettingsView }
  | { type: 'settings.result'; requestId: string; error: string | null };

export type SettingsClientMessage =
  | { type: 'settings.get' }
  | { type: 'mcp.save'; requestId: string; level: McpLevel; name: string; entry: McpEntry; previousName: string | null }
  | { type: 'mcp.remove'; requestId: string; level: McpLevel; name: string }
  | { type: 'mcp.approve'; requestId: string; name: string; entryHash: string }
  | { type: 'mcp.confirm-external-edits'; requestId: string; fileHashes: FileHashes };
