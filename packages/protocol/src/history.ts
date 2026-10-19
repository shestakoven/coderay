import type { ReviewGraph, ReviewGraphFile } from './review';
import type { ControlMode } from './settings';

export type ChangeOrigin = 'ide' | 'agent' | 'agent-tool' | 'git' | 'human' | 'unknown';
export type Enforcement = 'enforced' | 'recorded';
export type ChangeResolution = 'kept' | 'reverted' | 'plan-expanded' | 'relabeled-human' | 'flagged';
export interface ChangeView {
  id: string; path: string;
  beforeHash: string | null; afterHash: string | null;
  at: number;
  origin: ChangeOrigin; enforcement: Enforcement; outOfPlan: boolean;
  toolUseIds: string[]; planId: string | null; planVersion: number | null; stepKey: string | null;
  eventId: string | null; resolution: ChangeResolution | null;
  added: number | null; removed: number | null;
  stored: boolean; unreadable: boolean;
  beforeMode: number | null;
}
export type WatchdogKind = 'watchdog' | 'fail-open';
export type EventPhase = 'collecting' | 'pending' | 'resolved';
export type EventResolution = 'pending' | 'kept' | 'reverted' | 'plan-expanded' | 'relabeled-human' | 'flagged' | 'mixed' | 'dropped';
export interface WatchdogToolCall { toolUseId: string; tool: string; summary: string; stepKey: string | null }
export interface WatchdogEventView {
  id: string; kind: WatchdogKind; mode: ControlMode; phase: EventPhase; resolution: EventResolution;
  changes: ChangeView[]; toolCalls: WatchdogToolCall[];
  interrupted: boolean; paused: boolean; runningSubagents: number; backgroundShell: boolean;
  unknownOrigin: boolean; snapshotSha: string | null; canExpand: boolean;
  defaultAction: 'revert' | null; reason: string | null; ts: number; resolvedAt: number | null;
}
export type FileAnswer = 'keep' | 'revert' | 'mine';
export type WatchdogAnswer = { kind: 'all'; answer: FileAnswer | 'expand-plan' } | { kind: 'files'; files: Record<string, FileAnswer> };
export type RevertOutcome = 'restored' | 'deleted' | 'recreated' | 'conflict' | 'not-rolled-back';
export interface RevertFile { path: string; outcome: RevertOutcome; reason: string | null }
export interface RevertRecordView { id: string; kind: 'watchdog' | 'step' | 'review'; eventId: string | null; planId: string | null; stepKey: string | null; changeIds: string[]; files: RevertFile[]; ts: number; undoneAt: number | null }
export interface RollbackPreview { planId: string; stepKey: string; allowed: boolean; reason: string | null; autoFiles: string[]; confirmFiles: string[]; notRolledBack: { path: string; why: string }[]; conflicts: { path: string; reason: string }[] }
export interface CheckpointView { planId: string; stepKey: string; cycle: number; before: number; after: number | null; startedAt: number; sealedAt: number | null }
export interface GateEventView { id: string; kind: 'pre-execution' | 'watchdog' | 'fail-open'; toolUseId: string | null; mode: ControlMode; targets: string[]; resolution: string; ts: number; resolvedAt: number | null }
export interface SummaryView { key: string; scope: 'step' | 'component'; ref: string; text: string | null; pending: boolean }
export interface HistoryView { changes: ChangeView[]; events: WatchdogEventView[]; reverts: RevertRecordView[]; checkpoints: CheckpointView[]; gateEvents: GateEventView[]; summaries: SummaryView[] }
export type HistoryPatch = Partial<HistoryView>;
export interface DiffLine { op: 'context' | 'add' | 'del'; text: string }
export interface DiffHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[] }
export interface FileDiff { binary: boolean; truncated: boolean; missing: boolean; added: number; removed: number; hunks: DiffHunk[] }
export type HistoryServerMessage =
  | { type: 'history.snapshot'; history: HistoryView }
  | { type: 'history.patch'; patch: HistoryPatch }
  | { type: 'history.result'; requestId: string; error: string | null; diff?: FileDiff; preview?: RollbackPreview; graph?: ReviewGraph };
export type HistoryClientMessage =
  | { type: 'watchdog.answer'; eventId: string; answer: WatchdogAnswer }
  | { type: 'watchdog.stop-agent'; eventId: string }
  | { type: 'history.diff'; requestId: string; path: string; before: string | null; after: string | null }
  | { type: 'review.graph'; requestId: string; planId: string | null; files: ReviewGraphFile[] }
  | { type: 'revert.undo'; requestId: string; revertId: string }
  | { type: 'change.revert'; requestId: string; changeIds: string[] }
  | { type: 'step.rollback-preview'; requestId: string; planId: string; stepKey: string }
  | { type: 'step.rollback'; requestId: string; planId: string; stepKey: string; confirm: string[] };
