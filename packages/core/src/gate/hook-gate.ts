import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ControlMode, GateAnswer, GatePreview, GatePromptView, GateTarget, GateTargetKind, Policy, ToolDecision } from '@ide/protocol';
import { summarizeToolInput } from '../agent/tools';
import { isRecord } from '../json';
import { ownerIndex } from '../plans/freeze';
import type { ComponentRef } from '../plans/plan-input';
import type { PlanService } from '../plans/plan-service';
import type { GateEventRecord, GateResolution, Store, ToolDecisionRecord } from '../store/store';
import { classifyPaths, expandHome, realTarget } from './paths';
import { decide, describeTargets, targetName, type ClassifiedTarget, type GuardDecision } from './scope-guard';
import { shellWrites, type ShellTarget } from './shell';
import { FILE_PATH_FIELD, toolClass, type ToolClass } from './tools';

export const GATE_HOLD_MS = 3_530_000;
const PREVIEW_CHARS = 20_000;
const KEPT_CLOSED = 50;
const NO_RESPONSE = "IDE: the user did not respond in time. Stop and wait for the user's next message.";
const CALL_ENDED = 'IDE: the call ended before the user answered.';

export interface HookAnswer {
  permissionDecision: 'allow' | 'deny';
  permissionDecisionReason: string;
}

export interface GateContext {
  parentToolUseId: string | null;
  lastMessage: string | null;
}

export interface HookGateOptions {
  root: string;
  store: Store;
  sessionId: () => string | null;
  policy: () => Policy;
  plans: Pick<PlanService, 'gate' | 'canExpand' | 'expand'>;
  components: () => ComponentRef[];
  context: (toolUseId: string) => GateContext;
  home?: string;
  tempRoots?: string[];
  env?: NodeJS.ProcessEnv;
  holdMs?: number;
  now?: () => number;
  newId?: () => string;
}

export class GateError extends Error {}

interface HookInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  cwd: string;
}

interface Judged {
  decision: GuardDecision;
  targets: ClassifiedTarget[];
}

interface Landing {
  raw: string;
  abs: string;
  mkdir: boolean;
}

type Outcome = GateAnswer | 'closed' | 'timeout' | 'tool-ended';

interface Pending {
  view: GatePromptView;
  event: GateEventRecord;
  judged: Judged;
  settle(outcome: Outcome): void;
}

const allow = (reason: string): HookAnswer => ({ permissionDecision: 'allow', permissionDecisionReason: reason });
const deny = (reason: string): HookAnswer => ({ permissionDecision: 'deny', permissionDecisionReason: reason });

export class HookGate {
  private readonly options: HookGateOptions;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly promptListeners = new Set<(prompts: GatePromptView[]) => void>();
  private readonly decisionListeners = new Set<(decision: ToolDecisionRecord) => void>();
  private readonly pending = new Map<string, Pending>();
  private closed: GatePromptView[] = [];

  constructor(options: HookGateOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  onChange(listener: (prompts: GatePromptView[]) => void): () => void {
    this.promptListeners.add(listener);
    return () => this.promptListeners.delete(listener);
  }

  onDecision(listener: (decision: ToolDecisionRecord) => void): () => void {
    this.decisionListeners.add(listener);
    return () => this.decisionListeners.delete(listener);
  }

  prompts(): GatePromptView[] {
    return [...[...this.pending.values()].map((pending) => pending.view), ...this.closed];
  }

  async evaluate(raw: unknown, signal: AbortSignal): Promise<HookAnswer | null> {
    const input = parseHookInput(raw, this.options.root);
    if (!input) return deny('IDE: the hook input could not be read.');
    const mode = this.options.policy().mode;
    const judged = await this.judge(input);
    const { decision } = judged;
    if (decision.outcome === 'allow' || decision.outcome === 'unchecked') {
      this.record(input, judged, decision.outcome);
      return allow(decision.reason);
    }
    if (decision.outcome === 'deny') {
      this.record(input, judged, 'deny');
      if (decision.outOfScope.length > 0 || toolClass(input.toolName) === 'unknown') this.event(input, judged, mode, 'denied');
      return deny(decision.reason);
    }
    if (decision.outcome === 'flag') {
      this.record(input, judged, 'flag');
      this.event(input, judged, mode, 'flagged');
      return allow(decision.reason);
    }
    return this.ask(input, judged, mode, signal);
  }

  answer(promptId: string, answer: GateAnswer): void {
    const pending = this.pending.get(promptId);
    if (!pending) throw new GateError('That call is no longer waiting for an answer.');
    if (answer === 'expand-plan') {
      if (!pending.view.canExpand || !this.options.plans.canExpand()) throw new GateError('The plan cannot be expanded for this call.');
      this.options.plans.expand(pending.judged.decision.outOfScope.map((target) => ({ rel: target.rel as string, exists: target.exists, dir: target.dir })));
    }
    pending.settle(answer);
  }

  dropForTool(toolUseId: string): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.view.toolUseId === toolUseId) pending.settle('tool-ended');
    }
  }

  private async ask(input: HookInput, judged: Judged, mode: ControlMode, signal: AbortSignal): Promise<HookAnswer | null> {
    const view = this.promptView(input, judged, mode);
    const event: GateEventRecord = {
      id: view.id, toolUseId: input.toolUseId, kind: 'pre-execution', mode, targets: judged.decision.outOfScope.map(targetName),
      prompt: view, resolution: 'pending', ts: view.ts, resolvedAt: null,
    };
    const outcome = await new Promise<Outcome>((resolve) => {
      const onAbort = () => settle('closed');
      const timer = setTimeout(() => settle('timeout'), this.options.holdMs ?? GATE_HOLD_MS);
      timer.unref();
      const settle = (value: Outcome) => {
        if (!this.pending.has(view.id)) return;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.pending.delete(view.id);
        resolve(value);
      };
      this.pending.set(view.id, { view, event, judged, settle });
      this.saveEvent(event);
      this.emit();
      if (signal.aborted) settle('closed');
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    if (outcome === 'closed') {
      this.close(view, event, null, 'dropped');
      return null;
    }
    if (outcome === 'timeout' || outcome === 'tool-ended') {
      const reason = outcome === 'timeout' ? NO_RESPONSE : CALL_ENDED;
      this.close(view, event, null, 'dropped');
      this.record(input, judged, 'deny', reason);
      return deny(reason);
    }
    if (outcome === 'deny') {
      const reason = `IDE: the user denied this call (${describeTargets(judged.decision.outOfScope) || input.toolName}). Stop and wait for the user's next message.`;
      this.close(view, event, 'deny', 'denied');
      this.record(input, judged, 'ask-denied', reason);
      return deny(reason);
    }
    if (outcome === 'allow-once') {
      this.close(view, event, 'allow-once', 'allowed-once');
      this.record(input, judged, 'ask-approved', 'IDE: the user allowed this call once.');
      return allow('IDE: the user allowed this call once.');
    }
    const again = await this.judge(input);
    this.close(view, event, 'expand-plan', 'plan-expanded');
    if (again.decision.outcome === 'allow') {
      this.record(input, again, 'ask-approved', again.decision.reason);
      return allow(again.decision.reason);
    }
    this.record(input, again, 'deny', again.decision.reason);
    return deny(again.decision.reason);
  }

  private async judge(input: HookInput): Promise<Judged> {
    const policy = this.options.policy();
    const cls = toolClass(input.toolName);
    const targets = await this.targets(cls, input, policy);
    return { decision: decide({ tool: input.toolName, toolClass: cls, targets, gate: this.options.plans.gate(), mode: policy.mode }), targets };
  }

  private async targets(cls: ToolClass, input: HookInput, policy: Policy): Promise<ClassifiedTarget[]> {
    const home = this.options.home ?? homedir();
    if (cls === 'file-writer') {
      const path = input.toolInput[FILE_PATH_FIELD[input.toolName] as string];
      if (typeof path !== 'string' || path === '') return [special('unresolved', String(path ?? ''), 'no file path in the call')];
      return this.classify([{ raw: path, abs: realTarget(expandHome(path, home), input.cwd), mkdir: false }], policy, home);
    }
    if (cls !== 'shell') return [];
    const command = input.toolInput.command;
    if (typeof command !== 'string') return [special('unresolved', '', 'no command in the call')];
    const env = this.options.env ?? process.env;
    const writes = shellWrites(command, input.cwd, { home, vars: { TMPDIR: env.TMPDIR, TMP: env.TMP } });
    const found: ClassifiedTarget[] = writes.allTracked ? [special('all-tracked', 'git work tree', 'a git command that rewrites the work tree')] : [];
    const landings: Landing[] = [];
    for (const target of writes.targets) {
      if (target.unresolved !== null) found.push(special('unresolved', target.word, target.unresolved));
      else if (!target.temp) landings.push(...landingsOf(target));
    }
    return [...found, ...(await this.classify(landings, policy, home))];
  }

  private async classify(landings: Landing[], policy: Policy, home: string): Promise<ClassifiedTarget[]> {
    const infos = await classifyPaths(landings.map((landing) => landing.abs), { root: this.options.root, policy, home, tempRoots: this.options.tempRoots });
    return infos.map((info, index) => ({
      raw: landings[index]!.raw, kind: info.cls, rel: info.rel, abs: info.abs, dir: info.isDir,
      mkdir: landings[index]!.mkdir, exists: info.exists, guarded: info.guarded, why: info.why,
    }));
  }

  private promptView(input: HookInput, judged: Judged, mode: ControlMode): GatePromptView {
    const context = this.options.context(input.toolUseId);
    const owner = ownerIndex(this.options.components());
    const outOfScope = new Set(judged.decision.outOfScope);
    const targets: GateTarget[] = judged.decision.relevant.map((target) => ({
      path: targetName(target),
      kind: target.kind as GateTargetKind,
      inScope: !outOfScope.has(target),
      componentId: target.kind === 'enforced' && target.rel !== null ? owner(target.rel, target.exists) : null,
    }));
    const expandable = judged.decision.outOfScope.length > 0
      && judged.decision.outOfScope.every((target) => target.kind === 'enforced' && target.rel !== null);
    return {
      id: this.newId(), toolUseId: input.toolUseId, parentToolUseId: context.parentToolUseId, tool: input.toolName,
      summary: summarizeToolInput(input.toolInput, this.options.root), preview: preview(input), reason: context.lastMessage,
      targets, canExpand: expandable && this.options.plans.canExpand(), planId: judged.decision.planId, mode,
      status: 'pending', answer: null, ts: this.now(),
    };
  }

  private record(input: HookInput, judged: Judged, decision: ToolDecision, reason = judged.decision.reason): void {
    const record: ToolDecisionRecord = {
      toolUseId: input.toolUseId, decision, planId: judged.decision.planId, planVersion: judged.decision.version,
      stepKey: judged.decision.stepKey, targets: judged.targets.flatMap((target) => (target.rel === null ? [] : [target.rel])),
      reason, decidedAt: this.now(),
    };
    for (const listener of this.decisionListeners) listener(record);
  }

  private event(input: HookInput, judged: Judged, mode: ControlMode, resolution: GateResolution): void {
    const ts = this.now();
    this.saveEvent({
      id: this.newId(), toolUseId: input.toolUseId, kind: 'pre-execution', mode, targets: judged.decision.outOfScope.map(targetName),
      prompt: null, resolution, ts, resolvedAt: ts,
    });
  }

  private close(view: GatePromptView, event: GateEventRecord, answer: GateAnswer | null, resolution: GateResolution): void {
    const closed: GatePromptView = { ...view, status: answer === null ? 'dropped' : 'answered', answer };
    this.closed = [closed, ...this.closed].slice(0, KEPT_CLOSED);
    this.saveEvent({ ...event, prompt: closed, resolution, resolvedAt: this.now() });
    this.emit();
  }

  private saveEvent(event: GateEventRecord): void {
    const sessionId = this.options.sessionId();
    if (!sessionId) return;
    try {
      this.options.store.saveGateEvent(sessionId, event);
    } catch (error) {
      console.error('gate: could not save an out-of-plan event', error);
    }
  }

  private emit(): void {
    const prompts = this.prompts();
    for (const listener of this.promptListeners) listener(prompts);
  }
}

function parseHookInput(raw: unknown, root: string): HookInput | null {
  if (!isRecord(raw) || typeof raw.tool_name !== 'string' || typeof raw.tool_use_id !== 'string') return null;
  return {
    toolName: raw.tool_name,
    toolInput: isRecord(raw.tool_input) ? raw.tool_input : {},
    toolUseId: raw.tool_use_id,
    cwd: typeof raw.cwd === 'string' && raw.cwd !== '' ? raw.cwd : root,
  };
}

function special(kind: 'unresolved' | 'all-tracked', raw: string, why: string): ClassifiedTarget {
  return { raw, kind, rel: null, abs: null, dir: false, mkdir: false, exists: false, guarded: false, why };
}

function landingsOf(target: ShellTarget): Landing[] {
  const abs = realTarget(target.path as string, '/');
  let isDirectory = false;
  try {
    isDirectory = statSync(abs).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (target.names.length > 0 && isDirectory) return target.names.map((name) => ({ raw: `${target.word}/${name}`, abs: join(abs, name), mkdir: false }));
  return [{ raw: target.word, abs, mkdir: target.mkdir }];
}

function preview(input: HookInput): GatePreview {
  const cut = (text: string) => ({ text: text.slice(0, PREVIEW_CHARS), truncated: text.length > PREVIEW_CHARS });
  const record = input.toolInput;
  const path = typeof record.file_path === 'string' ? record.file_path : typeof record.notebook_path === 'string' ? record.notebook_path : '';
  if (input.toolName === 'Write' && typeof record.content === 'string') {
    const content = cut(record.content);
    return { kind: 'write', path, content: content.text, truncated: content.truncated };
  }
  if (input.toolName === 'Edit' && typeof record.old_string === 'string' && typeof record.new_string === 'string') {
    const before = cut(record.old_string);
    const after = cut(record.new_string);
    return { kind: 'edit', path, oldString: before.text, newString: after.text, truncated: before.truncated || after.truncated };
  }
  if (typeof record.command === 'string') {
    const command = cut(record.command);
    return { kind: 'command', command: command.text, truncated: command.truncated };
  }
  const text = cut(JSON.stringify(record, null, 2));
  return { kind: 'input', text: text.text, truncated: text.truncated };
}
