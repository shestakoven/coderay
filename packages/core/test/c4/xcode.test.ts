import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import type { C4Model, MapComponent } from '@ide/protocol';
import { buildC4 } from '../../src/c4/model';
import { readXcode } from '../../src/c4/xcode';
import type { IndexedFile } from '../../src/model';
import { indexed, tempDir, writeTree } from '../helpers';

const spec = (targets: Record<string, unknown>) => stringify({ name: 'Spec', targets });
const NO_TARGETS = 'name: Spec\n';
const compose = (services: Record<string, unknown>) => ({ 'docker-compose.yml': stringify({ services }) });

async function read(tree: Record<string, string>) {
  const root = tempDir('ide-xcode-');
  await writeTree(root, tree);
  return readXcode(root);
}

describe('readXcode', () => {
  it('finds project.yml files within three levels, skipping ignored directories', async () => {
    const found = await read({
      '.gitignore': 'build/\n',
      'project.yml': NO_TARGETS,
      'ios/project.yml': NO_TARGETS,
      'mobile/ios/project.yml': NO_TARGETS,
      'a/b/c/project.yml': NO_TARGETS,
      'a/b/c/d/project.yml': NO_TARGETS,
      'build/gen/project.yml': NO_TARGETS,
      'node_modules/pkg/project.yml': NO_TARGETS,
      'venv/lib/project.yml': NO_TARGETS,
    });
    expect(found.files).toEqual(['a/b/c/project.yml', 'ios/project.yml', 'mobile/ios/project.yml', 'project.yml']);
  });

  it('lists an application with its own sources first, then those of its embedded extensions', async () => {
    const found = await read({
      'ios-native/project.yml': spec({
        FocusCall: {
          type: 'application',
          platform: 'iOS',
          sources: ['FocusCall', { path: './Shared', excludes: ['Legacy'] }, 'FocusCall'],
          dependencies: [{ sdk: 'StoreKit.framework' }, { target: 'FocusWidget' }],
        },
        FocusWidget: { type: 'app-extension', sources: ['FocusWidget', 'Shared'] },
        FocusShare: { type: 'app-extension', sources: ['FocusShare'] },
        FocusCallTests: { type: 'bundle.unit-test', sources: ['FocusCallTests'] },
      }),
    });
    expect(found).toEqual({
      apps: [
        {
          name: 'FocusCall',
          platform: 'iOS',
          file: 'ios-native/project.yml',
          dirs: ['ios-native/FocusCall', 'ios-native/Shared', 'ios-native/FocusWidget', 'ios-native/FocusShare'],
        },
      ],
      files: ['ios-native/project.yml'],
      warnings: [],
    });
  });

  it('gives an extension only to the app that lists it and leaves an unclaimed one to neither of two apps', async () => {
    const found = await read({
      'apps/project.yml': spec({
        Main: { type: 'application', platform: 'iOS', sources: ['Main'], dependencies: [{ target: 'MainKit' }, { target: 'MainMessages' }] },
        Clip: { type: 'application.on-demand-install-capable', sources: ['Clip'] },
        MainKit: { type: 'framework', sources: ['MainKit'] },
        MainMessages: { type: 'app-extension.messages', sources: ['MainMessages'] },
        Stray: { type: 'app-extension', sources: ['Stray'] },
        MainTests: { type: 'bundle.unit-test', sources: ['MainTests'] },
      }),
    });
    expect(found.apps).toEqual([
      { name: 'Main', platform: 'iOS', file: 'apps/project.yml', dirs: ['apps/Main', 'apps/MainMessages'] },
      { name: 'Clip', platform: null, file: 'apps/project.yml', dirs: ['apps/Clip'] },
    ]);
  });

  it('warns about an unparsable spec and a spec-less Xcode project, and about nothing else', async () => {
    const broken = 'targets: [unclosed\nname: : :\n';
    const parseError = (() => {
      try {
        parse(broken);
      } catch (error) {
        return (error as Error).message.split('\n')[0];
      }
      throw new Error('the fixture must not parse');
    })();
    const found = await read({
      'good/project.yml': spec({ App: { type: 'application', platform: 'iOS', sources: ['App'] } }),
      'good/App.xcodeproj/project.pbxproj': '',
      'legacy/Old.xcodeproj/project.pbxproj': '',
      'ios/project.yml': broken,
      'empty/project.yml': NO_TARGETS,
      'tests-only/project.yml': spec({ UnitTests: { type: 'bundle.unit-test', sources: ['UnitTests'] } }),
    });
    expect({ apps: found.apps.map((app) => app.name), warnings: found.warnings.sort() }).toEqual({
      apps: ['App'],
      warnings: [`ios/project.yml: ${parseError}`, 'legacy/Old.xcodeproj: Xcode project without project.yml is not shown'],
    });
  });
});

describe('buildC4: native iOS app', () => {
  const component = (id: string, files: string[]): MapComponent => ({
    id,
    name: id,
    summary: '',
    description: '',
    files,
    keyFiles: [],
    globs: [],
    source: 'folder',
    stale: false,
  });

  async function build(tree: Record<string, string>, components: MapComponent[] = []): Promise<C4Model> {
    const root = tempDir('ide-xcode-c4-');
    await writeTree(root, tree);
    const files: IndexedFile[] = Object.keys(tree)
      .filter((path) => /\.(swift|py|ts)$/.test(path))
      .map((path) => indexed(path, path.endsWith('.swift') ? 'swift' : path.endsWith('.py') ? 'python' : 'typescript', []));
    return buildC4(root, files, [], components, new Map(), () => undefined).model;
  }

  const linksTo = (model: C4Model, id: string) => model.links.filter((link) => link.to === id);

  it('lists the app as a ui container counting its own and extension files but not tests or backend files', async () => {
    const model = await build(
      {
        'ios-native/project.yml': spec({
          FocusCall: { type: 'application', platform: 'iOS', sources: ['FocusCall', 'Shared'], dependencies: [{ target: 'FocusWidget' }] },
          FocusWidget: { type: 'app-extension', sources: ['FocusWidget'] },
          FocusCallTests: { type: 'bundle.unit-test', sources: ['FocusCallTests'] },
        }),
        'ios-native/FocusCall/App.swift': '',
        'ios-native/FocusCall/Views/Home.swift': '',
        'ios-native/FocusCall/Views/Call.swift': '',
        'ios-native/Shared/Model.swift': '',
        'ios-native/FocusWidget/Widget.swift': '',
        'ios-native/FocusCallTests/CallTests.swift': '',
        'backend/app/main.py': '',
        'backend/app/db.py': '',
      },
      [
        component('models', ['ios-native/Shared/Model.swift', 'backend/app/db.py']),
        component('views', [
          'ios-native/FocusCall/App.swift',
          'ios-native/FocusCall/Views/Home.swift',
          'ios-native/FocusCall/Views/Call.swift',
          'ios-native/FocusWidget/Widget.swift',
          'ios-native/FocusCallTests/CallTests.swift',
        ]),
        component('backend', ['backend/app/main.py', 'backend/app/db.py']),
      ],
    );
    expect(model.containers).toEqual([
      {
        id: 'container:FocusCall',
        name: 'FocusCall',
        role: 'ui',
        tech: 'Swift · iOS',
        launch: [],
        entryFiles: [],
        entryMissing: [],
        group: null,
        files: 5,
        components: [
          { id: 'views', files: 4, near: 4, containers: 1 },
          { id: 'models', files: 1, near: 1, containers: 1 },
        ],
        componentLinks: [],
        evidence: [{ path: 'ios-native/project.yml', note: 'target FocusCall' }],
      },
    ]);
    expect(linksTo(model, 'container:FocusCall').map((link) => [link.from, link.protocol, link.evidence.map((e) => e.note)])).toEqual([
      ['users', 'native app', ['installed by users']],
    ]);
  });

  it('keeps the users link to the web ui when the app is added', async () => {
    const model = await build({
      ...compose({ 'frontend-proxy': { build: './frontend', ports: ['80:80'] } }),
      'frontend/Dockerfile': 'FROM nginx:alpine\nCMD ["nginx", "-g", "daemon off;"]\n',
      'frontend/src/main.ts': '',
      'ios-native/project.yml': spec({ FocusCall: { type: 'application', platform: 'iOS', sources: ['FocusCall'] } }),
      'ios-native/FocusCall/App.swift': '',
    });
    const targets = model.links.filter((link) => link.from === 'users').map((link) => link.to);
    expect(targets.sort()).toEqual(['container:FocusCall', 'container:frontend-proxy']);
  });

  it('renames an app that shares a name with a compose service, skips an app without indexed sources and reports spec-less projects', async () => {
    const model = await build({
      ...compose({ focus: { build: './backend', command: 'uvicorn app.main:app' } }),
      'backend/app/main.py': '',
      'ios-native/project.yml': spec({
        focus: { type: 'application', sources: ['Focus'] },
        Ghost: { type: 'application', platform: 'iOS', sources: ['Ghost'] },
      }),
      'ios-native/Focus/App.swift': '',
      'legacy/Old.xcodeproj/project.pbxproj': '',
    });
    expect({
      containers: model.containers.map((c) => [c.id, c.name, c.tech.startsWith('Swift') ? c.tech : null]).sort(),
      users: linksTo(model, 'container:focus-app').map((link) => link.from),
      warnings: model.warnings,
    }).toEqual({
      containers: [
        ['container:focus', 'focus', null],
        ['container:focus-app', 'focus-app', 'Swift · Apple'],
      ],
      users: ['users'],
      warnings: ['legacy/Old.xcodeproj: Xcode project without project.yml is not shown'],
    });
  });
});
