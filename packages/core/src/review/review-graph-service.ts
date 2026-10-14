import type { PlanView, ReviewGraph, ReviewGraphFile } from '@ide/protocol';
import type { LanguageAdapter } from '../lang/types';
import type { IndexedFile } from '../model';
import { buildReviewGraph, type PlanRef } from './review-graph';

export interface ReviewGraphServiceOptions {
  files: () => IndexedFile[];
  components: () => { id: string; name: string; files: string[] }[];
  adapters: () => LanguageAdapter[];
  plans: () => PlanView[];
  content: (path: string, hash: string) => Promise<string | null>;
  readNow: (path: string) => Promise<string | null>;
}

function planRef(plan: PlanView): PlanRef {
  return {
    targets: plan.steps.flatMap((step) => step.targets.map((target) => ({ step: step.key, componentId: target.componentId, path: target.path }))),
    flow: plan.flow === null ? null : {
      nodes: plan.flow.nodes.map((node) => ({ id: node.id, files: node.files.map((file) => file.path) })),
      edges: plan.flow.edges.map((edge) => ({ from: edge.from, to: edge.to, state: edge.state })),
    },
  };
}

export class ReviewGraphService {
  constructor(private readonly o: ReviewGraphServiceOptions) {}

  async graph(request: { planId: string | null; files: ReviewGraphFile[] }): Promise<ReviewGraph> {
    const plan = request.planId === null ? undefined : this.o.plans().filter((candidate) => candidate.id === request.planId).sort((a, b) => b.version - a.version)[0];
    const hashes = new Map(request.files.map((file) => [file.path, file.before]));
    return buildReviewGraph({
      changed: request.files,
      current: this.o.files(),
      components: this.o.components(),
      adapters: this.o.adapters(),
      plan: plan === undefined ? null : planRef(plan),
      readBefore: async (path) => {
        const hash = hashes.get(path);
        if (hash === null || hash === undefined) return null;
        return this.o.content(path, hash).catch(() => null);
      },
      readNow: (path) => this.o.readNow(path),
    });
  }
}
