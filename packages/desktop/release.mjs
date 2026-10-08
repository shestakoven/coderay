// Builds the signed, notarized app and publishes it to GitHub Releases, where installed copies look for updates.
//   pnpm desktop:release                      the version in packages/desktop/package.json, which must be new
//   pnpm desktop:release -- --notes "text"    with release notes (default: the version alone)
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASES } from './releases.mjs';

const desktop = dirname(fileURLToPath(import.meta.url));
const dist = join(desktop, 'dist');
const { version } = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
const tag = `v${version}`;
const slug = `${RELEASES.owner}/${RELEASES.repo}`;
const notesFlag = process.argv.indexOf('--notes');
const notes = notesFlag === -1 ? `CodeRay ${version}` : process.argv[notesFlag + 1];
if (!notes) throw new Error('--notes needs a text.');

const run = (command, args) => execFileSync(command, args, { cwd: desktop, stdio: 'inherit' });
const gh = (...args) => spawnSync('gh', args, { cwd: desktop, encoding: 'utf8' });

// A build from uncommitted edits could not be reproduced from any commit.
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: desktop, encoding: 'utf8' }).trim();
if (dirty) throw new Error(`Commit or stash first, then release from the clean checkout:\n${dirty}`);

const repo = gh('repo', 'view', slug);
if (repo.status !== 0) throw new Error(`${slug} is not reachable with the gh login: ${repo.stderr.trim()}`);
const existing = gh('release', 'view', tag, '--repo', slug);
if (existing.status === 0) throw new Error(`${tag} is already released: raise "version" in packages/desktop/package.json.`);
if (!/release not found/i.test(existing.stderr)) throw new Error(`Could not look up ${tag}: ${existing.stderr.trim()}`);

run('node', ['build-app.mjs']);

const names = readdirSync(dist);
const assets = names.filter((name) => name === 'latest-mac.yml' || (name.includes(version) && /\.(dmg|zip|blockmap)$/.test(name)));
for (const pattern of [/\.dmg$/, /\.zip$/, /^latest-mac\.yml$/]) {
  if (!assets.some((name) => pattern.test(name))) throw new Error(`The build produced no ${pattern} for ${version}; found: ${names.join(', ')}`);
}
if (!new RegExp(`^version: ${version.replaceAll('.', '\\.')}$`, 'm').test(readFileSync(join(dist, 'latest-mac.yml'), 'utf8'))) {
  throw new Error(`dist/latest-mac.yml does not describe ${version}: it is from another build.`);
}

// Uploaded as a draft and published in one step, so an installed app never sees latest-mac.yml before the .zip it names.
run('gh', ['release', 'create', tag, ...assets.map((name) => join(dist, name)), '--repo', slug, '--title', `CodeRay ${version}`, '--notes', notes, '--draft']);
run('gh', ['release', 'edit', tag, '--repo', slug, '--draft=false', '--latest']);
console.log(`Published ${tag}: https://github.com/${slug}/releases/tag/${tag}`);
