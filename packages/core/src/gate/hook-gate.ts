import { randomUUID } from 'node:crypto';
import { lstatSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import type { ControlMode, GateAnswer, GatePreview, GatePromptView, GateTarget, GateTargetKind, Policy, ToolDecision } from '@ide/protocol';
import { summarizeToolInput } from '../agent/tools';
import { createRun, type GitRun } from '../git/git-run';
import { parseStatus } from '../git/status-parse';
import { isRecord } from '../json';
import { globOwners, ownerIndex } from '../plans/freeze';
import type { ComponentRef } from '../plans/plan-input';
import type { ExpandTarget, PlanService } from '../plans/plan-service';
import type { GateEventRecord, GateResolution, Store, ToolDecisionRecord } from '../store/store';
import type { Hold } from './hold';
import { classifyPaths, expandHome, realTarget } from './paths';
import { refreshWorktrees, worktreeAt } from './worktrees';
import { decide, describeTargets, targetName, type ClassifiedTarget, type GuardDecision } from './scope-guard';
import type { HistoryCall, ToolCall } from '../watchdog/activity';
import { shellWrites, type ShellTarget } from './shell';
import { FILE_PATH_FIELD, toolClass, type ToolClass } from './tools';

export const GATE_HOLD_MS = 3_530_000;
const PREVIEW_CHARS = 20_000;
const KEPT_CLOSED = 50;
const KEPT_DECIDED = 100_000;
const STATUS_MS = 5_000;
const NO_RESPONSE = "CodeRay: the user did not respond in time. Stop and wait for the user's next message.";
const CALL_ENDED = 'CodeRay: the call ended before the user answered.';

export interface HookAnswer {
  permissionDecision: 'allow' | 'deny';
  permissionDecisionReason: string;
  additionalContext?: string;
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
  plans: Pick<PlanService, 'gate' | 'canExpand' | 'expand' | 'onChange'>;
  components: () => ComponentRef[];
  context: (toolUseId: string) => GateContext;
  home?: string;
  tempRoots?: string[];
  env?: NodeJS.ProcessEnv;
  holdMs?: number;
  hold?: Hold;
  now?: () => number;
  newId?: () => string;
}

export class GateError extends Error {}

interface HookInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  cwd: string;
  batch?: Batch;
}

// Calls that run together or not at all: the plan expansion their answers ask for, and what each allowed one leaves behind.
interface Batch {
  expand: ExpandTarget[];
  effects: (() => void | Promise<void>)[];
}

interface Judged {
  decision: GuardDecision;
  targets: ClassifiedTarget[];
  history: HistoryCall[];
}

interface RepoState {
  top: string;
  head: string | null;
  dirty: string[];
}

interface Landing {
  raw: string;
  abs: string;
  mkdir: boolean;
  deleting: boolean;
}

type Outcome = GateAnswer | 'closed' | 'timeout' | 'tool-ended' | 'withdrawn' | 'fail-open';

interface Pending {
  view: GatePromptView;
  event: GateEventRecord;
  judged: Judged;
  expandable: boolean;
  batch: Batch | undefined;
  settle(outcome: Outcome): void;
}

const ALLOWED = new Set<ToolDecision>(['allow', 'unchecked', 'ask-approved', 'flag']);

const allow = (reason: string): HookAnswer => ({ permissionDecision: 'allow', permissionDecisionReason: reason });
const deny = (reason: string): HookAnswer => ({ permissionDecision: 'deny', permissionDecisionReason: reason });

export class HookGate {
  private readonly options: HookGateOptions;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly promptListeners = new Set<(prompts: GatePromptView[]) => void>();
  private readonly decisionListeners = new Set<(decision: ToolDecisionRecord) => void>();
  private readonly allowedListeners = new Set<(call: ToolCall) => void>();
  private readonly waiting = new Map<string, Pending>();
  private closed: GatePromptView[] = [];
  private judging: Promise<void> = Promise.resolve();
  private readonly decided = new Set<string>();
  private readonly inflight = new Map<string, number>();

  constructor(options: HookGateOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    options.plans.onChange(() => this.refreshExpand());
  }

  onChange(listener: (prompts: GatePromptView[]) => void): () => void {
    this.promptListeners.add(listener);
    return () => this.promptListeners.delete(listener);
  }

  onDecision(listener: (decision: ToolDecisionRecord) => void): () => void {
    this.decisionListeners.add(listener);
    return () => this.decisionListeners.delete(listener);
  }

  onAllowed(listener: (call: ToolCall) => void): () => void {
    this.allowedListeners.add(listener);
    return () => this.allowedListeners.delete(listener);
  }

  prompts(): GatePromptView[] {
    return [...[...this.waiting.values()].map((pending) => pending.view), ...this.closed];
  }

  pending(): GatePromptView[] {
    return this.prompts().filter((prompt) => prompt.status === 'pending');
  }

  evaluate(raw: unknown, signal: AbortSignal): Promise<HookAnswer | null> {
    return this.evaluateCall(raw, signal, undefined);
  }

  /**
   * Calls that run together or not at all (a Codex patch): asked about in turn, the first one not allowed answers for all, and what an
   * allowed one leaves (a plan expansion, its decision record, its prompt's resolution) happens only once every one is allowed.
   */
  async evaluateAll(raws: unknown[], signal: AbortSignal): Promise<HookAnswer | null> {
    if (raws.length === 1) return this.evaluate(raws[0], signal);
    const batch: Batch = { expand: [], effects: [] };
    let answer: HookAnswer | null = deny('CodeRay: there was no call to judge.');
    for (const raw of raws) {
      answer = await this.evaluateCall(raw, signal, batch);
      if (answer?.permissionDecision !== 'allow') return answer;
    }
    if (signal.aborted) return null;
    // Throws when the plan changed meanwhile so that it cannot be expanded: then none of the calls runs.
    if (batch.expand.length > 0) this.options.plans.expand([...new Map(batch.expand.map((target) => [`${target.rel}\0${target.deleted === true}`, target])).values()]);
    for (const effect of batch.effects) await effect();
    return answer;
  }

  private async evaluateCall(raw: unknown, signal: AbortSignal, batch: Batch | undefined): Promise<HookAnswer | null> {
    const parsed = parseHookInput(raw, this.options.root);
    if (!parsed) return deny('CodeRay: the hook input could not be read.');
    const input: HookInput = { ...parsed, batch };
    this.inflight.set(input.toolUseId, (this.inflight.get(input.toolUseId) ?? 0) + 1);
    try {
      return await this.admit(input, signal, this.now() + (this.options.holdMs ?? GATE_HOLD_MS));
    } finally {
      const left = (this.inflight.get(input.toolUseId) ?? 1) - 1;
      if (left > 0) this.inflight.set(input.toolUseId, left);
      else this.inflight.delete(input.toolUseId);
    }
  }

  hasCall(toolUseId: string): 'decided' | 'pending' | 'none' {
    if (this.decided.has(toolUseId)) return 'decided';
    return this.inflight.has(toolUseId) ? 'pending' : 'none';
  }

  private async admit(input: HookInput, signal: AbortSignal, deadline: number): Promise<HookAnswer | null> {
    const hold = this.options.hold;
    const held = hold !== undefined && toolClass(input.toolName) !== 'ide';
    for (;;) {
      let waited = false;
      if (held) {
        waited = hold.isHeld();
        const remaining = deadline - this.now();
        if (remaining <= 0) return deny(NO_RESPONSE);
        const wait = await hold.wait(signal, remaining);
        if (wait === 'aborted') return null;
        if (wait === 'timeout') return deny(NO_RESPONSE);
      }
      const mode = this.options.policy().mode;
      const generation = hold?.generation();
      const judged = waited ? await this.judgeInArrivalOrder(input) : await this.judge(input);
      if (signal.aborted) return null;
      if (held && (hold.isHeld() || hold.generation() !== generation)) continue;
      return this.resolve(input, judged, mode, signal, deadline);
    }
  }

  private async judgeInArrivalOrder(input: HookInput): Promise<Judged> {
    const before = this.judging;
    let done!: () => void;
    this.judging = new Promise<void>((resolve) => (done = resolve));
    await before;
    try {
      return await this.judge(input);
    } finally {
      done();
    }
  }

  withdrawPending(_reason: string): void {
    for (const pending of [...this.waiting.values()]) pending.settle('withdrawn');
  }

  private async resolve(input: HookInput, judged: Judged, mode: ControlMode, signal: AbortSignal, deadline: number): Promise<HookAnswer | null> {
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
      this.later(input.batch, () => this.event(input, judged, mode, 'flagged'));
      return allow(decision.reason);
    }
    return this.ask(input, judged, mode, signal, deadline);
  }

  answer(promptId: string, answer: GateAnswer): void {
    const pending = this.waiting.get(promptId);
    if (!pending) throw new GateError('That call is no longer waiting for an answer.');
    if (answer === 'expand-plan') {
      if (!pending.view.canExpand || !this.options.plans.canExpand()) throw new GateError('The plan cannot be expanded for this call.');
      if (pending.batch) pending.batch.expand.push(...expandTargets(pending.judged));
      else this.options.plans.expand(expandTargets(pending.judged));
    }
    pending.settle(answer);
  }

  dropForTool(toolUseId: string, options: { record?: boolean } = {}): void {
    for (const pending of [...this.waiting.values()]) {
      if (pending.view.toolUseId === toolUseId) pending.settle(options.record === false ? 'fail-open' : 'tool-ended');
    }
  }

  dropAll(): void {
    for (const pending of [...this.waiting.values()]) pending.settle('tool-ended');
  }

  private async ask(input: HookInput, judged: Judged, mode: ControlMode, signal: AbortSignal, deadline: number): Promise<HookAnswer | null> {
    const view = this.promptView(input, judged, mode);
    const event: GateEventRecord = {
      id: view.id, toolUseId: input.toolUseId, kind: 'pre-execution', mode, targets: judged.decision.outOfScope.map(targetName),
      prompt: view, resolution: 'pending', ts: view.ts, resolvedAt: null,
    };
    const outcome = await new Promise<Outcome>((resolve) => {
      const onAbort = () => settle('closed');
      const timer = setTimeout(() => settle('timeout'), Math.max(0, deadline - this.now()));
      timer.unref();
      const settle = (value: Outcome) => {
        if (!this.waiting.has(view.id)) return;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.waiting.delete(view.id);
        resolve(value);
      };
      this.waiting.set(view.id, { view, event, judged, expandable: isExpandable(judged), batch: input.batch, settle });
      this.saveEvent(event);
      this.emit();
      if (signal.aborted) settle('closed');
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    if (outcome === 'closed') {
      this.close(view, event, null, 'dropped');
      return null;
    }
    if (outcome === 'withdrawn') {
      this.close(view, event, null, 'dropped');
      return this.admit(input, signal, deadline);
    }
    if (outcome === 'fail-open') {
      this.close(view, event, null, 'dropped');
      return deny(CALL_ENDED);
    }
    if (outcome === 'timeout' || outcome === 'tool-ended') {
      const reason = outcome === 'timeout' ? NO_RESPONSE : CALL_ENDED;
      this.close(view, event, null, 'dropped');
      this.record(input, judged, 'deny', reason);
      return deny(reason);
    }
    if (outcome === 'deny') {
      const reason = `CodeRay: the user denied this call (${describeTargets(judged.decision.outOfScope) || input.toolName}). Stop and wait for the user's next message.`;
      this.close(view, event, 'deny', 'denied');
      this.record(input, judged, 'ask-denied', reason);
      return deny(reason);
    }
    if (outcome === 'allow-once') {
      this.close(view, event, 'allow-once', 'allowed-once', input.batch);
      this.record(input, judged, 'ask-approved', 'CodeRay: the user allowed this call once.');
      return allow('CodeRay: the user allowed this call once.');
    }
    if (input.batch) {
      this.close(view, event, 'expand-plan', 'plan-expanded', input.batch);
      this.record(input, judged, 'ask-approved', undefined, false);
      return allow('CodeRay: the user expanded the plan for this call.');
    }
    const generation = this.options.hold?.generation();
    const again = await this.judge(input);
    this.close(view, event, 'expand-plan', 'plan-expanded');
    if (signal.aborted) return null;
    if (this.options.hold && (this.options.hold.isHeld() || this.options.hold.generation() !== generation)) return this.admit(input, signal, deadline);
    if (again.decision.outcome === 'allow') {
      this.record(input, again, 'ask-approved', again.decision.reason, false);
      return allow(again.decision.reason);
    }
    return this.resolve(input, again, this.options.policy().mode, signal, deadline);
  }

  private async judge(input: HookInput): Promise<Judged> {
    const policy = this.options.policy();
    const cls = toolClass(input.toolName);
    const { targets, history } = await this.targets(cls, input, policy);
    return { decision: decide({ tool: input.toolName, toolClass: cls, targets, gate: this.options.plans.gate(), mode: policy.mode }), targets, history };
  }

  private async targets(cls: ToolClass, input: HookInput, policy: Policy): Promise<{ targets: ClassifiedTarget[]; history: HistoryCall[] }> {
    const home = this.options.home ?? homedir();
    if (cls === 'file-writer') {
      const path = input.toolInput[FILE_PATH_FIELD[input.toolName] as string];
      if (typeof path !== 'string' || path === '') return { targets: [special('unresolved', String(path ?? ''), 'no file path in the call')], history: [] };
      return { targets: await this.classify([{ raw: path, abs: realTarget(expandHome(path, home), input.cwd), mkdir: false, deleting: false }], policy, home), history: [] };
    }
    if (cls !== 'shell') return { targets: [], history: [] };
    const command = input.toolInput.command;
    if (typeof command !== 'string') return { targets: [special('unresolved', '', 'no command in the call')], history: [] };
    const env = this.options.env ?? process.env;
    const writes = shellWrites(command, input.cwd, { home, vars: { TMPDIR: env.TMPDIR, TMP: env.TMP } });
    await refreshWorktrees(this.options.root);
    // A rewrite inside a nested worktree touches that worktree only, which is no reason to ask for the whole project.
    const rewritesProject = writes.rewrites.some((dir) => dir === null || worktreeAt(this.options.root, realTarget(dir, '/')) === null);
    const repos = await Promise.all(writes.history.map((dir, i) => this.repoState(dir, writes.incoming[i]!)));
    // A history command is judged by the local files it may discard or overwrite; when git cannot say which, it may touch every tracked file.
    const found: ClassifiedTarget[] = rewritesProject || repos.includes(null) ? [special('all-tracked', 'git work tree', 'a git command that rewrites the work tree')] : [];
    const history: HistoryCall[] = [];
    const dirty = new Map<string, Landing>();
    for (const repo of repos) {
      if (repo === null) continue;
      const dir = this.projectDir(repo.top);
      if (dir !== null) history.push({ dir, top: repo.top, head: repo.head });
      for (const path of repo.dirty) dirty.set(join(repo.top, path), { raw: path, abs: join(repo.top, path), mkdir: false, deleting: false });
    }
    for (const dir of writes.moves) {
      const nested = await this.nestedHistory(dir);
      if (nested !== null) history.push(nested);
    }
    const landings: Landing[] = [];
    for (const target of writes.targets) {
      if (target.unresolved !== null) found.push(special('unresolved', target.word, target.unresolved));
      else if (!target.temp) landings.push(...landingsOf(target));
    }
    const uncommitted = (await this.classify([...dirty.values()], policy, home)).map((target) => ({ ...target, uncommitted: true }));
    return { targets: [...found, ...uncommitted, ...(await this.classify(landings, policy, home))], history };
  }

  // HEAD, and the files a git command may overwrite where it runs: tracked ones with uncommitted changes, and untracked or ignored ones
  // (an .env) that a commit it brings in tracks. Null when that cannot be read.
  private async repoState(dir: string | null, incoming: string[] | null): Promise<RepoState | null> {
    if (dir === null || incoming === null) return null;
    const run = createRun(realTarget(dir, '/'));
    const read = { readOnly: true, timeoutMs: STATUS_MS };
    try {
      const [top, status, listed, commits] = await Promise.all([
        run(['rev-parse', '--show-toplevel'], read),
        run(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no'], read),
        run(['ls-files', '-v', '-z'], read),
        Promise.all(incoming.map((ref) => commitOf(run, ref))),
      ]);
      const { sha, files } = parseStatus(status);
      const repoTop = top.trim();
      const added = await Promise.all(commits.filter((commit) => commit !== null).map((commit) =>
        run(sha === null ? ['ls-tree', '-r', '--name-only', '-z', commit] : ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', sha, commit], read)));
      const overwritten = added.flatMap((names) => names.split('\0')).flatMap((path) => (path === '' ? [] : clobbered(repoTop, path)));
      const dirty = files.flatMap((file) => (file.origPath === null ? [file.path] : [file.path, file.origPath]));
      // git status hides edits to a file marked --assume-unchanged (a lowercase tag), and git overwrites them.
      const assumed = listed.split('\0').filter((entry) => /^[a-z] /.test(entry)).map((entry) => entry.slice(2));
      return { top: repoTop, head: sha, dirty: [...new Set([...dirty, ...assumed, ...overwritten])] };
    } catch {
      return null;
    }
  }

  // The history call of a nested worktree that a rewrite names, which asks about nothing: what git moves there is still git's.
  private async nestedHistory(dir: string | null): Promise<HistoryCall | null> {
    if (dir === null || worktreeAt(this.options.root, realTarget(dir, '/')) === null) return null;
    const run = createRun(realTarget(dir, '/'));
    const read = { readOnly: true, timeoutMs: STATUS_MS };
    try {
      const [top, head] = (await Promise.all([run(['rev-parse', '--show-toplevel'], read), run(['rev-parse', '--verify', 'HEAD'], read)])).map((out) => out.trim());
      const at = this.projectDir(top!);
      return at === null ? null : { dir: at, top: top!, head: head! };
    } catch {
      return null;
    }
  }

  // Where a repository's top lies under the project root ("" for the root, or for a repository around it); null for any other repository.
  private projectDir(top: string): string | null {
    return this.relativeCwd(top) ?? (relative(top, this.options.root).startsWith('..') ? null : '');
  }

  private async classify(landings: Landing[], policy: Policy, home: string): Promise<ClassifiedTarget[]> {
    const infos = await classifyPaths(landings.map((landing) => landing.abs), { root: this.options.root, policy, home, tempRoots: this.options.tempRoots });
    const components = this.options.components();
    const owner = ownerIndex(components);
    return infos.map((info, index) => {
      const project = info.scopeRel ?? info.rel;
      return {
        raw: landings[index]!.raw, kind: info.cls, rel: info.rel, abs: info.abs, dir: info.isDir,
        mkdir: landings[index]!.mkdir, deleting: landings[index]!.deleting, exists: info.exists, guarded: info.guarded, why: info.why,
        unowned: info.cls === 'enforced' && project !== null && !info.isDir && !info.exists && owner(project, false) === null
          && globOwners(components, project).length === 0,
        ...(info.scopeRel === undefined ? {} : { scopeRel: info.scopeRel }),
      };
    });
  }

  private refreshExpand(): void {
    const canExpand = this.options.plans.canExpand();
    let changed = false;
    for (const pending of this.waiting.values()) {
      const next = pending.expandable && canExpand;
      if (pending.view.canExpand === next) continue;
      pending.view = { ...pending.view, canExpand: next };
      changed = true;
    }
    if (changed) this.emit();
  }

  private promptView(input: HookInput, judged: Judged, mode: ControlMode): GatePromptView {
    const context = this.options.context(input.toolUseId);
    const owner = ownerIndex(this.options.components());
    const outOfScope = new Set(judged.decision.outOfScope);
    const targets: GateTarget[] = judged.decision.relevant.map((target) => ({
      path: targetName(target),
      kind: target.kind as GateTargetKind,
      inScope: !outOfScope.has(target),
      deleting: target.deleting,
      componentId: target.kind === 'enforced' && target.rel !== null ? owner(target.scopeRel ?? target.rel, target.exists) : null,
      ...(target.uncommitted ? { uncommitted: true } : {}),
    }));
    return {
      id: this.newId(), toolUseId: input.toolUseId, parentToolUseId: context.parentToolUseId, tool: input.toolName,
      summary: summarizeToolInput(input.toolInput, this.options.root), preview: preview(input), reason: context.lastMessage,
      targets, canExpand: isExpandable(judged) && this.options.plans.canExpand(), planId: judged.decision.planId, mode,
      status: 'pending', answer: null, ts: this.now(),
    };
  }

  private record(
    input: HookInput, judged: Judged, decision: ToolDecision, reason?: string,
    allowedOnce = decision === 'ask-approved' || decision === 'flag',
  ): void {
    const batch = input.batch;
    // On the plan as it is once the batch is allowed: the record names the plan version that covers its call.
    if (batch && ALLOWED.has(decision)) batch.effects.push(async () => this.write(input, batch.expand.length > 0 ? await this.judge(input) : judged, decision, reason, allowedOnce));
    else this.write(input, judged, decision, reason, allowedOnce);
  }

  private write(input: HookInput, judged: Judged, decision: ToolDecision, reason = judged.decision.reason, allowedOnce: boolean): void {
    const record: ToolDecisionRecord = {
      toolUseId: input.toolUseId, decision, planId: judged.decision.planId, planVersion: judged.decision.version,
      stepKey: judged.decision.stepKey, targets: judged.targets.flatMap((target) => (target.rel === null ? [] : [target.rel])),
      reason, decidedAt: this.now(),
    };
    this.decided.add(input.toolUseId);
    if (this.decided.size > KEPT_DECIDED) this.decided.delete(this.decided.values().next().value as string);
    for (const listener of this.decisionListeners) {
      try {
        listener(record);
      } catch (error) {
        console.error('gate: a decision listener threw', error);
      }
    }
    if (ALLOWED.has(decision)) this.announce(input, judged, allowedOnce);
  }

  private announce(input: HookInput, judged: Judged, allowedOnce: boolean): void {
    const cls = toolClass(input.toolName);
    const background = cls === 'subagent' || (cls === 'shell' && (input.toolName === 'Monitor' || input.toolInput.run_in_background === true));
    const call: ToolCall = {
      toolUseId: input.toolUseId, parentToolUseId: this.options.context(input.toolUseId).parentToolUseId, tool: input.toolName, toolClass: cls,
      targets: judged.targets.flatMap((target) => (target.rel === null ? [] : [target.rel])),
      allTracked: judged.targets.some((target) => target.kind === 'all-tracked'),
      cwdRel: background && cls === 'shell' ? this.relativeCwd(input.cwd) : null, background, allowedOnce, history: judged.history,
    };
    for (const listener of this.allowedListeners) {
      try {
        listener(call);
      } catch (error) {
        console.error('gate: an allowed-call listener threw', error);
      }
    }
  }

  private relativeCwd(cwd: string): string | null {
    const rel = relative(this.options.root, cwd);
    return rel.startsWith('..') || isAbsolute(rel) ? null : rel;
  }

  private event(input: HookInput, judged: Judged, mode: ControlMode, resolution: GateResolution): void {
    const ts = this.now();
    this.saveEvent({
      id: this.newId(), toolUseId: input.toolUseId, kind: 'pre-execution', mode, targets: judged.decision.outOfScope.map(targetName),
      prompt: null, resolution, ts, resolvedAt: ts,
    });
  }

  private close(view: GatePromptView, event: GateEventRecord, answer: GateAnswer | null, resolution: GateResolution, batch?: Batch): void {
    const closed: GatePromptView = { ...view, status: answer === null ? 'dropped' : 'answered', answer };
    this.closed = [closed, ...this.closed].slice(0, KEPT_CLOSED);
    const save = (as: GateResolution) => this.saveEvent({ ...event, prompt: closed, resolution: as, resolvedAt: this.now() });
    // Until every call of its batch is allowed, and for good when one is not, the call was dropped.
    if (batch) save('dropped');
    this.later(batch, () => save(resolution));
    this.emit();
  }

  // What a call of a batch leaves waits until every call of the batch is allowed.
  private later(batch: Batch | undefined, effect: () => void): void {
    if (batch) batch.effects.push(effect);
    else effect();
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
    for (const listener of this.promptListeners) {
      try {
        listener(prompts);
      } catch (error) {
        console.error('gate: a prompt listener threw', error);
      }
    }
  }
}

function isExpandable(judged: Judged): boolean {
  const { outOfScope } = judged.decision;
  return outOfScope.length > 0 && outOfScope.every((target) => target.kind === 'enforced' && target.rel !== null);
}

function expandTargets(judged: Judged): ExpandTarget[] {
  return judged.decision.outOfScope.map((target) => ({ rel: target.scopeRel ?? target.rel as string, exists: target.exists, dir: target.dir, deleted: target.deleting }));
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

// A name git resolves, or a branch of exactly one remote, which checkout and switch take for a new local branch.
async function commitOf(run: GitRun, ref: string): Promise<string | null> {
  const read = { readOnly: true, timeoutMs: STATUS_MS };
  try {
    return (await run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], read)).trim();
  } catch (error) {
    // ORIG_HEAD is absent until the first rebase, merge or reset, and an --abort then has nothing to go back to.
    if (ref === 'ORIG_HEAD') return null;
    const remote = new Set((await run(['for-each-ref', '--format=%(objectname)', `refs/remotes/*/${ref}`], read)).split('\n').filter(Boolean));
    if (remote.size !== 1) throw error;
    return [...remote][0]!;
  }
}

// What git overwrites to add path: a file or link where it needs one of the directories, or the path itself; nothing when neither is on disk.
function clobbered(top: string, path: string): string[] {
  const names = path.split('/');
  for (let i = 1; i <= names.length; i += 1) {
    const at = names.slice(0, i).join('/');
    let directory: boolean;
    try {
      directory = lstatSync(join(top, at)).isDirectory();
    } catch {
      return [];
    }
    if (i === names.length || !directory) return [at];
  }
  return [];
}

function special(kind: 'unresolved' | 'all-tracked', raw: string, why: string): ClassifiedTarget {
  return { raw, kind, rel: null, abs: null, dir: false, mkdir: false, deleting: false, exists: false, guarded: false, why };
}

function landingsOf(target: ShellTarget): Landing[] {
  const abs = realTarget(target.path as string, '/');
  let isDirectory = false;
  try {
    isDirectory = statSync(abs).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (target.names.length > 0 && isDirectory) return target.names.map((name) => ({ raw: `${target.word}/${name}`, abs: join(abs, name), mkdir: false, deleting: false }));
  return [{ raw: target.word, abs, mkdir: target.mkdir, deleting: target.deleting }];
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
  // A Codex edit comes as its diff; after claude's strings, so a stray diff field never hides what an Edit replaces.
  if (input.toolName === 'Edit' && typeof record.diff === 'string') {
    const diff = cut(record.diff);
    return { kind: 'patch', path, diff: diff.text, truncated: diff.truncated };
  }
  if (typeof record.command === 'string') {
    const command = cut(record.command);
    return { kind: 'command', command: command.text, truncated: command.truncated };
  }
  const text = cut(JSON.stringify(record, null, 2));
  return { kind: 'input', text: text.text, truncated: text.truncated };
}
