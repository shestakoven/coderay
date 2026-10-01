import { randomUUID } from 'node:crypto';
import type { ApprovedBy, FrozenScope, PlanAnswer, PlanStatus, PlanStep, PlanView, StepStatus } from '@ide/protocol';
import { escapeGlob } from '../gate/scope';
import type { PlanGate } from '../gate/scope-guard';
import { isRecord } from '../json';
import type { PlanRecord, Store } from '../store/store';
import { freezeScope, ownerIndex, type ReviewResult } from './freeze';
import { parsePlanInput, type ComponentRef } from './plan-input';

export const PLAN_DEADLINE_MS = 3_540_000;
const REJECT_PAUSE_NOTE = 'You rejected the previous plan; this plan waits for you.';
const COMPLETED_FIRST = 'The plan was completed before this revision was answered.';
const NO_ANSWER = "The user did not answer within 59 minutes. Stop and wait for the user's next message.";

export type ProposeResult = { status: 'approved' | 'changes_requested' | 'rejected'; feedback?: string };
export type ProposeOutcome = { ok: true; value: ProposeResult } | { ok: false; error: string };
export type StepOutcome = { ok: true } | { ok: false; error: string };

export class PlanError extends Error {}

export interface StepEvent { planId: string; version: number; key: string; phase: 'start' | 'done' | 'reset' }

export interface ExpandTarget {
  rel: string;
  exists: boolean;
  dir: boolean;
  deleted?: boolean;
}

export interface PlanServiceOptions {
  root: string;
  store: Store;
  sessionId: () => string | null;
  components: () => ComponentRef[];
  review: (steps: PlanStep[]) => Promise<ReviewResult>;
  now?: () => number;
  newId?: () => string;
  deadlineMs?: number;
}

interface Waiter {
  resolve: (result: ProposeResult) => void;
  timer: NodeJS.Timeout;
}

const keyOf = (record: PlanRecord): string => `${record.id}@${record.version}`;
const OPEN_LATEST = new Set<PlanStatus>(['proposed', 'changes-requested']);

export class PlanService {
  private readonly options: PlanServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly listeners = new Set<(plans: PlanView[]) => void>();
  private readonly stepListeners = new Set<(event: StepEvent) => void>();
  private readonly waiters = new Map<string, Waiter>();
  private loadedFor: string | null | undefined = undefined;
  private rejectPause = false;
  private records: PlanRecord[] = [];
  private states = new Map<string, Map<string, StepStatus>>();

  constructor(options: PlanServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => `plan-${randomUUID().slice(0, 8)}`);
  }

  onChange(listener: (plans: PlanView[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  plans(): PlanView[] {
    this.load();
    return this.records.map((record) => this.view(record));
  }

  async propose(raw: unknown, signal?: AbortSignal): Promise<ProposeOutcome> {
    this.load();
    const session = this.loadedFor;
    if (session === null || session === undefined) return { ok: false, error: 'IDE: there is no agent session.' };
    const components = this.options.components();
    const input = parsePlanInput(raw, this.options.root, components);
    if (typeof input === 'string') return { ok: false, error: input };
    const reviewed = await this.options.review(input.steps);
    this.load();
    if (this.loadedFor !== session) return { ok: false, error: 'IDE: the agent session changed while the plan was checked.' };
    if (signal?.aborted) return { ok: false, error: 'IDE: the call was cancelled.' };
    const open = this.openPlanId();
    if (open !== null) {
      const problem = this.keepsProgress(open, input.steps);
      if (problem) return { ok: false, error: problem };
    }
    const id = open ?? this.newId();
    const version = open === null ? 1 : Math.max(...this.versions(open).map((record) => record.version)) + 1;
    for (const older of this.versions(id).filter((record) => record.status === 'proposed')) {
      const feedback = `Superseded by version ${version}.`;
      this.settle(older, 'superseded', feedback, { status: 'rejected', feedback });
    }
    const review = this.rejectPause && reviewed.review.auto ? { auto: false, notes: [REJECT_PAUSE_NOTE, ...reviewed.review.notes] } : reviewed.review;
    const record: PlanRecord = {
      id, version, goal: input.goal, status: 'proposed', approvedBy: null, steps: input.steps,
      scope: freezeScope(input.steps, this.options.root, components), owners: reviewed.owners, review,
      feedback: null, proposedAt: this.now(), decidedAt: null,
    };
    this.records.push(record);
    if (!this.states.has(id)) this.states.set(id, new Map());
    if (review.auto) {
      this.approve(record, 'auto');
      return { ok: true, value: { status: 'approved' } };
    }
    this.save(record);
    this.emit();
    return { ok: true, value: await this.wait(record, signal) };
  }

  answer(planId: string, version: number, answer: PlanAnswer): void {
    this.load();
    const record = this.records.find((candidate) => candidate.id === planId && candidate.version === version);
    if (!record) throw new PlanError('That plan is not part of this session.');
    if (answer.kind === 'reject') {
      this.rejectPause = true;
      this.reject(record, answer.feedback.trim());
      return;
    }
    if (record.status !== 'proposed') throw new PlanError('That plan is no longer waiting for an answer.');
    if (answer.kind === 'changes') {
      const feedback = answer.feedback.trim();
      if (!feedback) throw new PlanError('Say what should change.');
      this.settle(record, 'changes-requested', feedback, { status: 'changes_requested', feedback });
      return;
    }
    record.scope = freezeScope(record.steps, this.options.root, this.options.components());
    this.approve(record, 'user-card');
  }

  userMessage(): void {
    this.rejectPause = false;
  }

  step(raw: unknown): StepOutcome {
    this.load();
    const input = isRecord(raw) ? raw : {};
    const key = typeof input.key === 'string' ? input.key : '';
    if (!key || (input.phase !== 'start' && input.phase !== 'done')) {
      return { ok: false, error: 'IDE: step needs {"key": "<step key>", "phase": "start" | "done"}.' };
    }
    const gate = this.gate();
    if (gate.state === 'rejected') return { ok: false, error: `IDE: the user rejected plan ${gate.planId}. Stop and wait for the user's next message.` };
    if (gate.state === 'done') return { ok: false, error: `IDE: plan ${gate.planId} is done.` };
    if (gate.state === 'none') return { ok: false, error: 'IDE: no plan is approved. Call mcp__idecore__propose_plan first and wait for its result.' };
    const enforced = this.enforced(gate.planId)!;
    if (!enforced.steps.some((step) => step.key === key)) {
      return { ok: false, error: `IDE: plan ${gate.planId} has no step "${key}". Its steps: ${enforced.steps.map((step) => step.key).join(', ')}.` };
    }
    if (!this.states.has(gate.planId)) this.states.set(gate.planId, new Map());
    const states = this.states.get(gate.planId)!;
    const status = states.get(key) ?? 'pending';
    if (status === 'done') return { ok: false, error: `IDE: step "${key}" is already done.` };
    if (input.phase === 'start') {
      // Starting the next step finishes the active one, so a hand-over takes one call.
      if (gate.activeStep !== null && gate.activeStep !== key) {
        const closed = this.step({ key: gate.activeStep, phase: 'done' });
        if (!closed.ok) return closed;
      }
      if (status !== 'active') {
        this.setStep(gate.planId, key, 'active');
        this.emitStep({ planId: gate.planId, version: gate.version, key, phase: 'start' });
        this.emit();
      }
      return { ok: true };
    }
    if (status !== 'active') return { ok: false, error: `IDE: step "${key}" is not active; start it first.` };
    this.setStep(gate.planId, key, 'done');
    this.emitStep({ planId: gate.planId, version: gate.version, key, phase: 'done' });
    if (enforced.steps.every((step) => states.get(step.key) === 'done')) {
      enforced.status = 'done';
      enforced.decidedAt = this.now();
      this.save(enforced);
      this.withdrawWaitingRevisions(enforced);
    }
    this.emit();
    return { ok: true };
  }

  resetStep(planId: string, key: string): void {
    this.load();
    const enforced = this.enforced(planId) ?? this.versions(planId).findLast((record) => record.status === 'done');
    if (!enforced || !enforced.steps.some((step) => step.key === key)) throw new PlanError(`Plan ${planId} has no step "${key}".`);
    const status = this.states.get(planId)?.get(key) ?? 'pending';
    if (status === 'pending') throw new PlanError(`Step "${key}" has not run.`);
    this.setStep(planId, key, 'pending');
    try {
      this.options.store.bumpStepCycle(planId, key);
    } catch (error) {
      console.error('plans: could not bump a step cycle', error);
    }
    if (enforced.status === 'done') {
      enforced.status = 'approved';
      enforced.decidedAt = this.now();
      this.save(enforced);
    }
    this.emitStep({ planId, version: enforced.version, key, phase: 'reset' });
    this.emit();
  }

  onStep(listener: (event: StepEvent) => void): () => boolean {
    this.stepListeners.add(listener);
    return () => this.stepListeners.delete(listener);
  }

  stepStates(): Record<string, Record<string, StepStatus>> {
    this.load();
    return Object.fromEntries([...this.states].map(([planId, states]) => [planId, Object.fromEntries(states)]));
  }

  gate(): PlanGate {
    this.load();
    const planId = this.records.at(-1)?.id;
    if (planId === undefined) return { state: 'none' };
    const enforced = this.enforced(planId);
    if (enforced) return { state: 'approved', planId, version: enforced.version, scope: enforced.scope, activeStep: this.activeStep(planId) };
    const versions = this.versions(planId);
    if (versions.some((record) => record.status === 'done')) return { state: 'done', planId };
    if (versions.some((record) => record.status === 'rejected')) return { state: 'rejected', planId };
    return { state: 'none' };
  }

  scopeOf(planId: string, version: number): FrozenScope | null {
    this.load();
    const record = this.records.find((candidate) => candidate.id === planId && candidate.version === version);
    return record && (record.status === 'approved' || record.status === 'done') ? record.scope : null;
  }

  canExpand(): boolean {
    const gate = this.gate();
    if (gate.state !== 'approved') return false;
    if (this.versions(gate.planId).some((record) => record.status === 'proposed')) return false;
    return this.expandStep(gate.planId) !== null;
  }

  expand(targets: ExpandTarget[]): PlanView {
    const gate = this.gate();
    if (gate.state !== 'approved' || !this.canExpand()) throw new PlanError('The plan cannot be expanded now.');
    const enforced = this.enforced(gate.planId)!;
    const stepKey = this.expandStep(gate.planId)!;
    const steps = enforced.steps.map((step) => {
      if (step.key !== stepKey) return step;
      const listed = new Set(step.targets.flatMap((target) => (target.path === undefined ? [] : [`${target.path}\0${target.op === 'delete'}`])));
      const added = targets
        .filter((target) => !listed.has(`${target.rel}\0${target.deleted === true}`))
        .map((target) => ({ path: target.rel, op: target.deleted ? ('delete' as const) : target.exists ? ('modify' as const) : ('create' as const) }));
      return { ...step, targets: [...step.targets, ...added] };
    });
    const owner = ownerIndex(this.options.components());
    const record: PlanRecord = {
      ...enforced,
      version: Math.max(...this.versions(gate.planId).map((candidate) => candidate.version)) + 1,
      status: 'approved',
      approvedBy: 'user-expand',
      steps,
      scope: {
        ...(enforced.scope.deletes === undefined ? {} : {
          deletes: {
            paths: [...new Set([...enforced.scope.deletes.paths, ...targets.filter((target) => target.deleted && !target.dir).map((target) => target.rel)])].sort(),
            globs: [...new Set([...enforced.scope.deletes.globs, ...targets.filter((target) => target.deleted && target.dir).map((target) => `${escapeGlob(target.rel)}/**`)])].sort(),
          },
        }),
        paths: [...new Set([...enforced.scope.paths, ...targets.filter((target) => !target.dir).map((target) => target.rel)])].sort(),
        globs: [...new Set([...enforced.scope.globs, ...targets.filter((target) => target.dir).map((target) => `${escapeGlob(target.rel)}/**`)])].sort(),
      },
      owners: { ...enforced.owners, ...Object.fromEntries(targets.filter((target) => !target.dir).map((target) => [target.rel, owner(target.rel, target.exists)])) },
      review: { auto: false, notes: ['expanded by the user from an out-of-plan prompt'] },
      feedback: null,
      proposedAt: this.now(),
      decidedAt: this.now(),
    };
    enforced.status = 'superseded';
    this.save(enforced);
    this.records.push(record);
    this.save(record);
    this.emit();
    return this.view(record);
  }

  withdrawPending(reason: string): void {
    for (const record of this.records) {
      if (record.status === 'proposed') this.settle(record, 'withdrawn', reason, { status: 'rejected', feedback: reason });
    }
  }

  private load(): void {
    const sessionId = this.options.sessionId();
    if (sessionId === this.loadedFor) return;
    this.withdrawPending('The agent session ended.');
    this.loadedFor = sessionId;
    this.rejectPause = false;
    const saved = sessionId === null ? { plans: [], stepStates: {} } : this.options.store.plans(sessionId);
    this.records = saved.plans;
    this.states = new Map(Object.entries(saved.stepStates).map(([planId, states]) => [planId, new Map(Object.entries(states))]));
    for (const record of this.records) {
      if (record.status !== 'proposed') continue;
      record.status = 'withdrawn';
      record.feedback = 'The IDE core restarted while the plan waited for an answer.';
      record.decidedAt = this.now();
      this.save(record);
    }
  }

  private withdrawWaitingRevisions(done: PlanRecord): void {
    for (const record of this.versions(done.id)) {
      if (record.status === 'proposed') this.settle(record, 'withdrawn', COMPLETED_FIRST, { status: 'rejected', feedback: COMPLETED_FIRST });
      else if (record.status === 'changes-requested') {
        record.status = 'withdrawn';
        record.feedback = COMPLETED_FIRST;
        record.decidedAt = this.now();
        this.save(record);
      }
    }
  }

  private wait(record: PlanRecord, signal?: AbortSignal): Promise<ProposeResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(record, 'withdrawn', NO_ANSWER, { status: 'rejected', feedback: NO_ANSWER }), this.options.deadlineMs ?? PLAN_DEADLINE_MS);
      timer.unref();
      this.waiters.set(keyOf(record), { resolve, timer });
      const cancel = () => this.settle(record, 'withdrawn', "The agent's call was cancelled.", { status: 'rejected', feedback: 'Cancelled.' });
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
    });
  }

  private settle(record: PlanRecord, status: PlanStatus, feedback: string | null, result: ProposeResult): void {
    if (record.status !== 'proposed') return;
    record.status = status;
    record.feedback = feedback;
    record.decidedAt = this.now();
    this.save(record);
    this.emit();
    this.release(record, result);
  }

  private release(record: PlanRecord, result: ProposeResult): void {
    const waiter = this.waiters.get(keyOf(record));
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(keyOf(record));
    waiter.resolve(result);
  }

  private approve(record: PlanRecord, by: ApprovedBy): void {
    for (const other of this.versions(record.id)) {
      if (other === record || other.status !== 'approved') continue;
      other.status = 'superseded';
      this.save(other);
    }
    record.status = 'approved';
    record.approvedBy = by;
    record.decidedAt = this.now();
    this.save(record);
    this.emit();
    this.release(record, { status: 'approved' });
  }

  private reject(record: PlanRecord, feedback: string): void {
    const open = this.versions(record.id).filter((candidate) => OPEN_LATEST.has(candidate.status) || candidate.status === 'approved');
    if (!open.includes(record)) throw new PlanError('Only a waiting or approved plan can be rejected.');
    const result: ProposeResult = feedback ? { status: 'rejected', feedback } : { status: 'rejected' };
    for (const version of open) {
      version.status = 'rejected';
      version.feedback = feedback || null;
      version.decidedAt = this.now();
      this.save(version);
      this.release(version, result);
    }
    this.emit();
  }

  private openPlanId(): string | null {
    const planId = this.records.at(-1)?.id;
    if (planId === undefined) return null;
    const versions = this.versions(planId);
    if (versions.some((record) => record.status === 'rejected' || record.status === 'done')) return null;
    const latest = versions.at(-1)!;
    return this.enforced(planId) || OPEN_LATEST.has(latest.status) ? planId : null;
  }

  private keepsProgress(planId: string, steps: PlanStep[]): string | null {
    const keys = new Set(steps.map((step) => step.key));
    for (const [key, status] of this.states.get(planId) ?? []) {
      if (status !== 'pending' && !keys.has(key)) return `IDE: the new version must keep step "${key}", which is ${status}.`;
    }
    return null;
  }

  private expandStep(planId: string): string | null {
    const active = this.activeStep(planId);
    if (active !== null) return active;
    const states = this.states.get(planId);
    const steps = [...(this.enforced(planId)?.steps ?? [])].sort((a, b) => a.order - b.order);
    return steps.find((step) => (states?.get(step.key) ?? 'pending') === 'pending')?.key ?? null;
  }

  private activeStep(planId: string): string | null {
    for (const [key, status] of this.states.get(planId) ?? []) if (status === 'active') return key;
    return null;
  }

  private setStep(planId: string, key: string, status: StepStatus): void {
    if (!this.states.has(planId)) this.states.set(planId, new Map());
    this.states.get(planId)!.set(key, status);
    try {
      this.options.store.saveStepState(planId, key, status);
    } catch (error) {
      console.error('plans: could not save a step state', error);
    }
  }

  private emitStep(event: StepEvent): void {
    for (const listener of this.stepListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('plans: a step listener failed', error);
      }
    }
  }

  private enforced(planId: string): PlanRecord | undefined {
    return this.versions(planId).findLast((record) => record.status === 'approved');
  }

  private versions(planId: string): PlanRecord[] {
    return this.records.filter((record) => record.id === planId);
  }

  private save(record: PlanRecord): void {
    if (!this.loadedFor) return;
    try {
      this.options.store.savePlan(this.loadedFor, record);
    } catch (error) {
      console.error('plans: could not save a plan', error);
    }
  }

  private emit(): void {
    const plans = this.records.map((record) => this.view(record));
    for (const listener of this.listeners) {
      try {
        listener(plans);
      } catch (error) {
        console.error('plans: a plan listener threw', error);
      }
    }
  }

  private view(record: PlanRecord): PlanView {
    const states = this.states.get(record.id);
    return {
      id: record.id, version: record.version, goal: record.goal, status: record.status, approvedBy: record.approvedBy,
      steps: record.steps.map((step) => ({ ...step, status: states?.get(step.key) ?? 'pending' })),
      scope: record.scope, owners: record.owners, review: record.review, feedback: record.feedback,
      proposedAt: record.proposedAt, decidedAt: record.decidedAt,
    };
  }
}
