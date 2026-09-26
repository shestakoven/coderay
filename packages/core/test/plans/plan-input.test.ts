import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePlanInput, type ComponentRef } from '../../src/plans/plan-input';
import { tempDir, writeTree } from '../helpers';

const components: ComponentRef[] = [
  { id: 'app', name: 'App', files: ['src/app.ts'], globs: [] },
  { id: 'lib', name: 'Lib', files: ['src/lib/util.ts'], globs: ['src/lib/**'] },
];

const step = (targets: unknown[], extra: object = {}) => ({ key: 'edit', title: 'Edit', rationale: 'why', targets, ...extra });

async function root(): Promise<string> {
  const dir = tempDir('ide-plan-');
  await writeTree(dir, { 'src/app.ts': '', 'src/lib/util.ts': '' });
  return dir;
}

describe('parsePlanInput', () => {
  it('reads a plan with component and path targets, numbering the steps in order', async () => {
    const dir = await root();
    const plan = parsePlanInput({
      goal: ' Fix the bug ',
      steps: [step([{ componentId: 'lib', op: 'modify' }]), step([{ path: 'src/new.ts', op: 'create' }], { key: 'add' })],
    }, dir, components);
    expect(plan).toEqual({
      goal: 'Fix the bug',
      steps: [
        { key: 'edit', order: 1, title: 'Edit', rationale: 'why', targets: [{ componentId: 'lib', op: 'modify' }] },
        { key: 'add', order: 2, title: 'Edit', rationale: 'why', targets: [{ path: 'src/new.ts', op: 'create' }] },
      ],
    });
  });

  it('accepts an absolute path inside the project and stores it relative to the root', async () => {
    const dir = await root();
    expect(parsePlanInput({ goal: 'g', steps: [step([{ path: join(dir, 'src/app.ts'), op: 'modify' }])] }, dir, components))
      .toMatchObject({ steps: [{ targets: [{ path: 'src/app.ts', op: 'modify' }] }] });
  });

  it('lists the valid component ids when a target names an unknown one', async () => {
    const dir = await root();
    expect(parsePlanInput({ goal: 'g', steps: [step([{ componentId: 'nope', op: 'modify' }])] }, dir, components))
      .toBe('IDE: step "edit" names an unknown component "nope". Valid component ids: app (App), lib (Lib).');
  });

  it('refuses a path outside the project, through .. or a symlink', async () => {
    const dir = await root();
    const outside = tempDir('ide-outside-');
    symlinkSync(outside, join(dir, 'link'));
    for (const path of ['../elsewhere.ts', '/etc/hosts', 'link/f.ts', '.']) {
      expect(parsePlanInput({ goal: 'g', steps: [step([{ path, op: 'modify' }])] }, dir, components))
        .toBe(`IDE: "${path}" in step "edit" is not a path inside the project.`);
    }
  });

  it('stores a path through a symlink inside the project as its real path', async () => {
    const dir = await root();
    symlinkSync(join(dir, 'src/lib'), join(dir, 'src/alias'));
    expect(parsePlanInput({ goal: 'g', steps: [step([{ path: 'src/alias/util.ts', op: 'modify' }])] }, dir, components))
      .toMatchObject({ steps: [{ targets: [{ path: 'src/lib/util.ts', op: 'modify' }] }] });
  });

  it('refuses wildcards in a path but allows brackets', async () => {
    const dir = await root();
    expect(parsePlanInput({ goal: 'g', steps: [step([{ path: 'src/*.ts', op: 'modify' }])] }, dir, components))
      .toBe('IDE: "src/*.ts" in step "edit" contains a wildcard; name files or directories.');
    expect(parsePlanInput({ goal: 'g', steps: [step([{ path: 'app/[id]/page.tsx', op: 'create' }])] }, dir, components))
      .toMatchObject({ steps: [{ targets: [{ path: 'app/[id]/page.tsx' }] }] });
  });

  it.each([
    [{}, 'IDE: the plan needs a "goal".'],
    [{ goal: 'g', steps: [] }, 'IDE: the plan needs at least one step.'],
    [{ goal: 'g', steps: [step([{ path: 'a', op: 'modify' }]), step([{ path: 'b', op: 'modify' }])] }, 'IDE: two steps have the key "edit"; keys must be unique.'],
    [{ goal: 'g', steps: [step([])] }, 'IDE: step "edit" needs at least one target.'],
    [{ goal: 'g', steps: [step([{ path: 'a', op: 'rename' }])] }, 'IDE: a target of step "edit" needs "op": "modify", "create" or "delete".'],
    [{ goal: 'g', steps: [step([{ path: 'a', componentId: 'app', op: 'modify' }])] }, 'IDE: each target of step "edit" names either a "componentId" or a "path".'],
    [{ goal: 'g', steps: [step([{ path: 'a', op: 'modify' }], { title: ' ' })] }, 'IDE: step "edit" needs a "title".'],
  ])('refuses %j', async (raw, error) => {
    expect(parsePlanInput(raw, await root(), components)).toBe(error);
  });
});
