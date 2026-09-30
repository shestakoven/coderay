import { statSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { FrozenScope, PlanReview, PlanStep, Policy } from '@ide/protocol';
import { classifyPaths } from '../gate/paths';
import { escapeGlob, globMatches, globSpecificity } from '../gate/scope';
import type { ComponentRef } from './plan-input';

export interface ReviewContext {
  root: string;
  policy: Policy;
  components: ComponentRef[];
  home?: string;
  tempRoots?: string[];
}

export interface ReviewResult {
  review: PlanReview;
  owners: Record<string, string | null>;
}

const MIN_SIBLINGS = 2;

function isDirectory(root: string, rel: string): boolean {
  try {
    return statSync(join(root, rel)).isDirectory();
  } catch {
    return false;
  }
}

export function freezeScope(steps: PlanStep[], root: string, components: ComponentRef[]): FrozenScope {
  const byId = new Map(components.map((component) => [component.id, component]));
  const paths = new Set<string>();
  const globs = new Set<string>();
  const deletePaths = new Set<string>();
  const deleteGlobs = new Set<string>();
  for (const step of steps) {
    for (const target of step.targets) {
      const removing = target.op === 'delete';
      if (target.componentId !== undefined) {
        const component = byId.get(target.componentId);
        for (const file of component?.files ?? []) {
          paths.add(file);
          if (removing) deletePaths.add(file);
        }
        for (const glob of component?.globs ?? []) {
          globs.add(glob);
          if (removing) deleteGlobs.add(glob);
        }
      } else if (target.path !== undefined) {
        if (isDirectory(root, target.path)) {
          globs.add(`${escapeGlob(target.path)}/**`);
          if (removing) deleteGlobs.add(`${escapeGlob(target.path)}/**`);
        } else {
          paths.add(target.path);
          if (removing) deletePaths.add(target.path);
        }
      }
    }
  }
  return { paths: [...paths].sort(), globs: [...globs].sort(), deletes: { paths: [...deletePaths].sort(), globs: [...deleteGlobs].sort() } };
}

// The components whose most specific matching glob is the most specific of all; more than one is a tie.
export function globOwners(components: ComponentRef[], rel: string): ComponentRef[] {
  const scored = components.flatMap((component) => {
    const depths = component.globs.filter((glob) => globMatches(rel, glob)).map(globSpecificity);
    return depths.length === 0 ? [] : [{ component, depth: Math.max(...depths) }];
  });
  const best = Math.max(-1, ...scored.map((entry) => entry.depth));
  return scored.filter((entry) => entry.depth === best).map((entry) => entry.component);
}

// The instant-assignment rules of spec §4.1 for a planned file: listed files, then globs, then siblings.
export function ownerIndex(components: ComponentRef[]): (rel: string, exists: boolean) => string | null {
  const fileOwner = new Map(components.flatMap((component) => component.files.map((file) => [file, component.id] as const)));
  return (rel, exists) => {
    const listed = fileOwner.get(rel);
    if (listed !== undefined) return listed;
    if (exists) return null;
    const byGlob = globOwners(components, rel);
    if (byGlob.length > 1) return null;
    if (byGlob.length === 1) return byGlob[0]!.id;
    const dir = posix.dirname(rel);
    const siblings = [...fileOwner].filter(([file]) => posix.dirname(file) === dir).map(([, id]) => id);
    return siblings.length >= MIN_SIBLINGS && new Set(siblings).size === 1 ? siblings[0]! : null;
  };
}

export async function reviewPlan(steps: PlanStep[], ctx: ReviewContext): Promise<ReviewResult> {
  const names = new Map(ctx.components.map((component) => [component.id, component.name]));
  const nameOf = (id: string) => names.get(id) ?? id;
  const max = ctx.policy.autoApproveMaxFiles;
  const notes: string[] = [];
  if (max === 0) notes.push('automatic approval is off');
  const targets = steps.flatMap((step) => step.targets);
  for (const target of targets) {
    if (target.componentId !== undefined) notes.push(`it targets the whole component ${nameOf(target.componentId)}`);
  }
  const pathTargets = targets.filter((target) => target.path !== undefined);
  for (const target of pathTargets) if (target.op === 'delete') notes.push(`it deletes ${target.path}`);
  const paths = [...new Set(pathTargets.map((target) => target.path as string))];
  const dirs = new Set(paths.filter((path) => isDirectory(ctx.root, path)));
  for (const dir of dirs) notes.push(`it targets the directory ${dir}`);
  const files = paths.filter((path) => !dirs.has(path));
  if (max > 0 && files.length > max) notes.push(`${files.length} files (the limit is ${max})`);
  const infos = await classifyPaths(files.map((path) => join(ctx.root, path)), {
    root: ctx.root, policy: ctx.policy, home: ctx.home, tempRoots: ctx.tempRoots,
  });
  const owner = ownerIndex(ctx.components);
  const owners: Record<string, string | null> = {};
  for (const info of infos) {
    const rel = info.rel as string;
    if (info.guarded) notes.push(`${rel} is a guarded path`);
    else if (info.cls !== 'enforced') notes.push(`${rel} is ${info.why}`);
    owners[rel] = owner(rel, info.exists);
    if (!info.exists && owners[rel] === null) {
      const both = globOwners(ctx.components, rel);
      notes.push(both.length > 1 ? `${rel} matches the globs of ${both.map((component) => component.name).join(' and ')}` : `the map cannot place the new file ${rel} in a component`);
    }
  }
  const distinct = [...new Set(Object.values(owners).filter((id): id is string => id !== null))];
  if (distinct.length > 1) notes.push(`files in ${distinct.length} components (${distinct.map(nameOf).join(', ')})`);
  if (notes.length > 0) return { review: { auto: false, notes }, owners };
  const where = distinct.length === 1 ? `in ${nameOf(distinct[0]!)}` : "outside the map's components";
  return { review: { auto: true, notes: [`${files.length} ${files.length === 1 ? 'file' : 'files'} ${where}`] }, owners };
}
