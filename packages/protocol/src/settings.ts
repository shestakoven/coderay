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

export interface McpSettingsView {
  servers: McpServerView[];
  problems: string[];
  fileHashes: FileHashes;
  externalEdits: { ideServers: boolean; trust: boolean; trustApproves: string[] };
}

export type ControlMode = 'A' | 'B' | 'C';

export interface Policy {
  mode: ControlMode;
  guarded: string[];
  harness: string[];
  outsideAllowed: string[];
  autoApproveMaxFiles: number;
}

export type PolicyLevel = 'ide' | 'project';

export interface PolicyHashes {
  ide: string;
  project: string;
}

export interface PolicyView {
  ide: Policy;
  project: Partial<Policy>;
  effective: Policy;
  hashes: PolicyHashes;
  externalEdits: { ide: boolean; project: boolean };
  edited: { ide: string | null; project: string | null };
  problems: string[];
}

export interface SettingsView extends McpSettingsView {
  policy: PolicyView;
}

export type SettingsServerMessage =
  | { type: 'settings.snapshot'; settings: SettingsView }
  | { type: 'settings.result'; requestId: string; error: string | null };

export type SettingsClientMessage =
  | { type: 'settings.get' }
  | { type: 'mcp.save'; requestId: string; level: McpLevel; name: string; entry: McpEntry; previousName: string | null }
  | { type: 'mcp.remove'; requestId: string; level: McpLevel; name: string }
  | { type: 'mcp.approve'; requestId: string; name: string; entryHash: string }
  | { type: 'mcp.confirm-external-edits'; requestId: string; fileHashes: FileHashes }
  | { type: 'policy.save'; requestId: string; level: PolicyLevel; policy: Partial<Policy> }
  | { type: 'policy.confirm-external-edits'; requestId: string; hashes: PolicyHashes };
