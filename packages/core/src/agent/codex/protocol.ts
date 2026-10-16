// A hand-picked subset of the types `codex app-server generate-ts` writes for codex-cli 0.160.0: regenerate from the pinned binary when the pin moves.

export const CODEX_PROTOCOL_VERSION = '0.160.0';

export type RequestId = string | number;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface InitializeResponse { userAgent: string; codexHome: string; platformFamily: string; platformOs: string }

export type Account = { type: 'apiKey' } | { type: 'chatgpt'; email: string | null; planType: string } | { type: 'amazonBedrock'; usesCodexManagedCredentials: boolean };
export interface GetAccountResponse { account: Account | null; requiresOpenaiAuth: boolean }
export type LoginAccountResponse =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; loginId: string; authUrl: string }
  | { type: 'chatgptDeviceCode'; loginId: string; verificationUrl: string; userCode: string };
export interface AccountLoginCompletedNotification { loginId: string | null; success: boolean; error: string | null }

export interface ReasoningEffortOption { reasoningEffort: string; description: string }
export interface Model { id: string; model: string; displayName: string; description: string; hidden: boolean; isDefault: boolean; defaultReasoningEffort: string; supportedReasoningEfforts: ReasoningEffortOption[] }
export interface ModelListResponse { data: Model[]; nextCursor: string | null }

export interface SkillMetadata { name: string; description: string; path: string; scope: string; enabled: boolean }
export interface SkillsListResponse { data: { cwd: string; skills: SkillMetadata[]; errors: { path: string; message: string }[] }[] }

export interface ConfigReadResponse { config: Record<string, JsonValue> }

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type AskForApproval = 'untrusted' | 'on-request' | 'never' | { granular: Record<string, boolean> };
export type ApprovalsReviewer = 'user' | 'auto_review' | 'guardian_subagent';
export type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'externalSandbox'; networkAccess: unknown }
  | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };

export interface ThreadStartResponse {
  thread: { id: string; cliVersion: string; path: string | null };
  model: string;
  approvalPolicy: AskForApproval;
  approvalsReviewer: ApprovalsReviewer;
  sandbox: SandboxPolicy;
  reasoningEffort: string | null;
  multiAgentMode?: 'explicitRequestOnly' | 'proactive' | { custom: string };
}

export type UserInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string }
  | { type: 'skill'; name: string; path: string };

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';
export interface Turn { id: string; status: TurnStatus; error: { message: string } | null }
export interface TurnStartResponse { turn: Turn }

export type PatchChangeKind = { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null };
export interface FileUpdateChange { path: string; kind: PatchChangeKind; diff: string }
export type ItemStatus = 'inProgress' | 'completed' | 'failed' | 'declined';
export type McpToolCallItem = {
  type: 'mcpToolCall'; id: string; server: string; tool: string; status: ItemStatus; arguments: JsonValue;
  result: { content: { type: string; text?: string }[] } | null; error: { message: string } | null;
};
export type ThreadItem =
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'reasoning'; id: string }
  | { type: 'userMessage'; id: string }
  | { type: 'commandExecution'; id: string; command: string; cwd: string; status: ItemStatus; commandActions: { type: string; command: string }[]; aggregatedOutput: string | null; exitCode: number | null }
  | { type: 'fileChange'; id: string; changes: FileUpdateChange[]; status: ItemStatus }
  | McpToolCallItem;

export interface TokenUsageBreakdown { totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number }
export interface ThreadTokenUsage { total: TokenUsageBreakdown; last: TokenUsageBreakdown; modelContextWindow: number | null }
export interface RateLimitWindow { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }
export interface RateLimitSnapshot { primary: RateLimitWindow | null; secondary: RateLimitWindow | null }

export type CommandExecutionApprovalKind = 'command' | 'writeStdin';
export interface NetworkApprovalContext { host: string; protocol: string }
export interface CommandExecutionRequestApprovalParams {
  kind: CommandExecutionApprovalKind; threadId: string; turnId: string; itemId: string; approvalId?: string | null;
  command?: string | null; cwd?: string | null; reason?: string | null; networkApprovalContext?: NetworkApprovalContext | null;
}
export interface FileChangeRequestApprovalParams { threadId: string; turnId: string; itemId: string; reason?: string | null; grantRoot?: string | null }
// What CodeRay answers a request for more permissions: none granted, for this turn only.
export interface PermissionsRequestApprovalResponse { permissions: Record<string, never>; scope: 'turn' }
export interface McpServerElicitationRequestParams {
  threadId: string; turnId: string | null; serverName: string; mode?: 'form' | 'openai/form' | 'openaiForm' | 'url'; message: string;
  _meta: { codex_approval_kind?: string; tool_params?: JsonValue } | null;
}
export interface ApprovalResponse { decision: 'accept' | 'decline' }
export interface ElicitationResponse { action: 'accept' | 'decline'; content: JsonValue; _meta: null }
