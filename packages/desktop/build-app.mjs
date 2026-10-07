// Builds the macOS app: the UI, the core as one bundle plus the few packages it loads at run time, and the Electron shell,
// signed with the Developer ID certificate and notarized with the notarytool keychain profile.
//   pnpm desktop:dist                    signed and notarized .dmg
//   pnpm desktop:dist -- --no-notarize   signed only, for a quick local check
//   pnpm desktop:dist -- --dir           the .app only, without the .dmg
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as bundle } from 'esbuild';
import { Arch, Platform, build } from 'electron-builder';

const PRODUCT_NAME = 'IDE';
const notarize = !process.argv.includes('--no-notarize');
const dmg = !process.argv.includes('--dir');

const desktop = dirname(fileURLToPath(import.meta.url));
const repo = resolve(desktop, '../..');
const coreSource = join(repo, 'packages/core');
const stage = join(desktop, 'out');
const core = join(stage, 'core');
// swift.ts finds its grammar at ../../grammars from its own module, so the bundle sits two levels below the grammars.
const coreBin = join(core, 'dist/bin');

// What the bundle cannot hold: native addons and WebAssembly found next to a package's own module.
const RUNTIME_PACKAGES = ['@huggingface/transformers', '@lydell/node-pty', 'web-tree-sitter'];
// Found by require.resolve for their compiled grammar only; their C sources and native bindings are build inputs.
const GRAMMAR_PACKAGES = ['tree-sitter-c', 'tree-sitter-c-sharp', 'tree-sitter-cpp', 'tree-sitter-python', 'tree-sitter-typescript'];
// ws loads these only when present; without them it uses its JavaScript fallback.
const OPTIONAL_PACKAGES = ['bufferutil', 'utf-8-validate'];
// transformers.node.mjs carries its own copy of onnxruntime-web and only names the package.
const UNUSED_PACKAGES = new Set(['onnxruntime-web']);

const run = (command, args, cwd = repo) => execFileSync(command, args, { cwd, stdio: 'inherit' });

// The native packages are copied from this Mac's install, so they are built for its architecture only.
if (process.arch !== 'arm64') throw new Error('The app is built for arm64 from this Mac\'s packages: build it on an Apple silicon Mac.');

rmSync(stage, { recursive: true, force: true });
mkdirSync(coreBin, { recursive: true });

run('pnpm', ['--filter', '@ide/ui', 'build']);

await bundle({
  entryPoints: { main: join(coreSource, 'src/main.ts'), 'embed-worker': join(coreSource, 'src/models/embed-worker.ts') },
  outdir: coreBin,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: [...RUNTIME_PACKAGES, ...GRAMMAR_PACKAGES, ...OPTIONAL_PACKAGES],
  // Bundled CommonJS packages call require(), which an ES module does not have.
  banner: { js: "import { createRequire as __ideCreateRequire } from 'node:module'; const require = __ideCreateRequire(import.meta.url);" },
  logLevel: 'warning',
});
for (const script of readdirSync(join(coreSource, 'src/hook')).filter((name) => name.endsWith('.mjs'))) cpSync(join(coreSource, 'src/hook', script), join(coreBin, script));
cpSync(join(coreSource, 'grammars'), join(core, 'grammars'), { recursive: true });
writeFileSync(join(core, 'package.json'), JSON.stringify({ name: 'ide-core', private: true, type: 'module' }, null, 2));

// Copied from the workspace install, so the app runs the versions the lockfile pinned and the tests ran against.
const modules = join(core, 'node_modules');
copyRuntimePackages(coreSource, modules);
for (const name of GRAMMAR_PACKAGES) {
  const dir = findPackage(name, coreSource);
  cpSync(dir, join(modules, name), { recursive: true, filter: (path) => path === dir || /\/(package\.json|LICENSE|[^/]+\.wasm)$/.test(path) });
}
keepOnlyThisMac(join(modules, 'onnxruntime-node/bin'));

// The core and its hooks run on the app's own binary as Node; see node-exec.ts in the core.
mkdirSync(join(stage, 'bin'));
const launcher = join(stage, 'bin/ide-node');
writeFileSync(launcher, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$(dirname "$0")/../../MacOS/${PRODUCT_NAME}" "$@"\n`);
chmodSync(launcher, 0o755);

if (notarize) process.env.APPLE_KEYCHAIN_PROFILE ??= 'notary';
const artifacts = await build({
  projectDir: desktop,
  targets: Platform.MAC.createTarget([dmg ? 'dmg' : 'dir'], Arch.arm64),
  config: {
    appId: 'com.shestakov.ide',
    productName: PRODUCT_NAME,
    directories: { output: 'dist' },
    files: ['main.mjs', 'chrome-insets.mjs', 'package.json'],
    // Chromium's own strings (menus, dialogs, spellcheck); each locale is a file to sign.
    electronLanguages: ['en', 'ru'],
    extraResources: [
      // electron-builder drops a node_modules at the root of a copied folder, so the stage is copied from its parent.
      { from: 'out', to: '.', filter: ['core/**/*', 'bin/**/*'] },
      { from: '../ui/dist', to: 'ui' },
    ],
    mac: {
      category: 'public.app-category.developer-tools',
      identity: process.env.CSC_NAME ?? 'Evgenii Shestakov (4N9UMF2P33)',
      hardenedRuntime: true,
      entitlements: 'entitlements.mac.plist',
      entitlementsInherit: 'entitlements.mac.plist',
      notarize,
    },
    dmg: { sign: true },
  },
});

// electron-builder notarizes the app inside; the disk image needs a ticket of its own to open without a warning once downloaded.
const image = artifacts.find((path) => path.endsWith('.dmg'));
if (notarize && image) {
  run('xcrun', ['notarytool', 'submit', image, '--keychain-profile', process.env.APPLE_KEYCHAIN_PROFILE, '--wait']);
  run('xcrun', ['stapler', 'staple', image]);
}

// Laid out flat, as a hoisted install would be; two versions of one package would need nesting, which none of these has.
function copyRuntimePackages(issuer, to) {
  const placed = new Map();
  const visit = (name, from) => {
    if (UNUSED_PACKAGES.has(name)) return;
    const dir = findPackage(name, from);
    // An optional dependency for another platform is not installed.
    if (!dir || placed.get(name) === dir) return;
    if (placed.has(name)) throw new Error(`${name} is needed in two versions: ${placed.get(name)} and ${dir}`);
    placed.set(name, dir);
    cpSync(dir, join(to, name), { recursive: true, dereference: true });
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) visit(dep, dir);
  };
  for (const name of RUNTIME_PACKAGES) visit(name, issuer);
}

// Node's lookup from a package's real location: each enclosing node_modules in turn.
function findPackage(name, from) {
  for (let dir = from; dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (basename(dir) !== 'node_modules' && existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
  }
  return null;
}

// onnxruntime-node ships its binaries for every platform.
function keepOnlyThisMac(bin) {
  for (const napi of readdirSync(bin)) {
    for (const os of readdirSync(join(bin, napi))) {
      if (os !== 'darwin') rmSync(join(bin, napi, os), { recursive: true });
      else for (const arch of readdirSync(join(bin, napi, os))) if (arch !== 'arm64') rmSync(join(bin, napi, os, arch), { recursive: true });
    }
  }
}
