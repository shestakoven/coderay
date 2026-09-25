import { describe, expect, it } from 'vitest';
import { createTypeScriptAdapter } from '../../src/lang/typescript';
import { tempDir, writeTree } from '../helpers';

const existing = (...paths: string[]) => (path: string) => paths.includes(path);
const pkg = (fields: Record<string, unknown>) => JSON.stringify(fields);

async function adapterFor(files: Record<string, string>) {
  const root = tempDir('ide-workspace-');
  await writeTree(root, files);
  return createTypeScriptAdapter(root);
}

describe('TypeScript adapter with workspace packages', () => {
  it('resolves a workspace package name to the source file its exports point to', async () => {
    const adapter = await adapterFor({
      'packages/protocol/package.json': pkg({ name: '@demo/protocol', exports: { '.': './src/index.ts' } }),
    });
    expect(adapter.resolve('packages/app/src/main.ts', '@demo/protocol', existing('packages/protocol/src/index.ts'))).toBe(
      'packages/protocol/src/index.ts',
    );
  });

  it('maps an export into a build directory back to the source file', async () => {
    const adapter = await adapterFor({
      'packages/utils/package.json': pkg({
        name: '@demo/utils',
        exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
      }),
    });
    expect(adapter.resolve('app.ts', '@demo/utils', existing('packages/utils/src/index.ts'))).toBe('packages/utils/src/index.ts');
  });

  it('maps an export into a module-format build directory such as dist/esm back to the source file', async () => {
    const adapter = await adapterFor({
      'packages/utils/package.json': pkg({ name: '@demo/utils', exports: { '.': { import: './dist/esm/index.js' } } }),
    });
    expect(adapter.resolve('app.ts', '@demo/utils', existing('packages/utils/src/index.ts'))).toBe('packages/utils/src/index.ts');
  });

  it('strips .d.mts and .d.cts declaration extensions from export targets', async () => {
    const adapter = await adapterFor({
      'packages/utils/package.json': pkg({ name: '@demo/utils', exports: { '.': { types: './dist/index.d.mts' } } }),
    });
    expect(adapter.resolve('app.ts', '@demo/utils', existing('packages/utils/src/index.ts'))).toBe('packages/utils/src/index.ts');
  });

  it('resolves a subpath through a wildcard export', async () => {
    const adapter = await adapterFor({
      'packages/utils/package.json': pkg({ name: '@demo/utils', exports: { './*': './src/*.ts' } }),
    });
    expect(adapter.resolve('app.ts', '@demo/utils/strings', existing('packages/utils/src/strings.ts'))).toBe(
      'packages/utils/src/strings.ts',
    );
  });

  it('picks the wildcard export with the longest prefix, as Node does', async () => {
    const adapter = await adapterFor({
      'packages/utils/package.json': pkg({
        name: '@demo/utils',
        exports: { './*': './src/*.ts', './text/*': './src/text/*/index.ts' },
      }),
    });
    const exists = existing('packages/utils/src/text/case.ts', 'packages/utils/src/text/case/index.ts');
    expect(adapter.resolve('app.ts', '@demo/utils/text/case', exists)).toBe('packages/utils/src/text/case/index.ts');
  });

  it('does not resolve a subpath that the exports map excludes with null', async () => {
    const adapter = await adapterFor({
      'packages/utils/package.json': pkg({ name: '@demo/utils', exports: { './*': './src/*.ts', './internal/*': null } }),
    });
    expect(adapter.resolve('app.ts', '@demo/utils/internal/secret', existing('packages/utils/src/internal/secret.ts'))).toBeNull();
  });

  it('falls back to main for a package without exports', async () => {
    const adapter = await adapterFor({ 'libs/legacy/package.json': pkg({ name: 'legacy', main: 'lib/main.js' }) });
    expect(adapter.resolve('app.ts', 'legacy', existing('libs/legacy/src/main.ts'))).toBe('libs/legacy/src/main.ts');
  });

  it('falls back to src/index for a package without exports or main', async () => {
    const adapter = await adapterFor({ 'libs/plain/package.json': pkg({ name: 'plain' }) });
    expect(adapter.resolve('app.ts', 'plain', existing('libs/plain/src/index.ts'))).toBe('libs/plain/src/index.ts');
  });

  it('does not resolve a subpath that the exports map does not export', async () => {
    const adapter = await adapterFor({
      'packages/protocol/package.json': pkg({ name: '@demo/protocol', exports: { '.': './src/index.ts' } }),
    });
    const exists = existing('packages/protocol/src/internal.ts', 'packages/protocol/internal.ts');
    expect(adapter.resolve('app.ts', '@demo/protocol/internal', exists)).toBeNull();
  });
});
