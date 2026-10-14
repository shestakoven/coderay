import { describe, expect, it } from 'vitest';
import { MAX_REVIEW_GRAPH_FILES, type PlanView, type ReviewGraph, type ReviewLink, type ReviewPart } from '@ide/protocol';
import { fileOutsidePlan, focusOf, graphFilesOf, graphKey, importedName, partOfPath, stepOutcomes, totalsOf, visibleMap } from '../src/history/review-map/review-map-model';

const part = (id: string, status: ReviewPart['status'], extra: Partial<ReviewPart> = {}): ReviewPart =>
  ({ id, title: id, status, steps: [], outside: false, files: [], broken: [], ...extra });
const link = (from: string, to: string, state: ReviewLink['state']): ReviewLink => ({ from, to, state, count: 1, evidence: [] });

describe('visibleMap', () => {
  it('shows every part with context; changed only, it keeps an unchanged part only where a flagged link ends in it, and links keep their index in the graph', () => {
    const graph: ReviewGraph = {
      parts: [part('api', 'modified'), part('db', 'untouched'), part('a', 'untouched'), part('b', 'untouched'), part('c', 'untouched'), part('d', 'untouched')],
      links: [link('api', 'db', 'existing'), link('a', 'api', 'broken'), link('api', 'b', 'unplanned'), link('api', 'c', 'removed'), link('api', 'd', 'missing')],
      partial: null,
    };
    expect(visibleMap(graph, true).parts).toHaveLength(6);
    const changed = visibleMap(graph, false);
    expect(changed.parts.map((p) => p.id)).toEqual(['api', 'a', 'b', 'c', 'd']);
    expect(changed.links.map((l) => l.index)).toEqual([1, 2, 3, 4]);
  });
});

describe('focusOf', () => {
  it('lights a part with its neighbours and the links that touch it, a link with its two ends only, and nothing the view does not draw', () => {
    const graph: ReviewGraph = {
      parts: [part('api', 'modified'), part('db', 'untouched'), part('log', 'untouched'), part('old', 'untouched')],
      links: [link('api', 'db', 'existing'), link('old', 'api', 'broken'), link('db', 'log', 'existing')],
      partial: null,
    };
    const all = visibleMap(graph, true);
    const around = focusOf(all, { t: 'part', id: 'api' })!;
    expect([[...around.parts].sort(), [...around.links].sort()]).toEqual([['api', 'db', 'old'], [0, 1]]);
    const ends = focusOf(all, { t: 'link', from: 'db', to: 'log' })!;
    expect([[...ends.parts].sort(), [...ends.links]]).toEqual([['db', 'log'], [2]]);
    const changed = visibleMap(graph, false);
    expect([focusOf(changed, { t: 'part', id: 'db' }), focusOf(changed, { t: 'link', from: 'api', to: 'db' })]).toEqual([null, null]);
  });
});

describe('graphFilesOf', () => {
  const section = (key: string, stepKey: string | null, files: { path: string; reverted?: boolean }[]) =>
    ({ key, stepKey, files: files.map((f) => ({ reverted: false, ...f, before: 'b', after: 'a', added: 1, removed: 0 })) }) as never;
  const sent = (path: string, step: string | null, external: boolean) => ({ path, before: 'b', after: 'a', step, external, added: 1, removed: 0 });

  it('sends the files the review shows with their step: reverted ones left out, external ones marked, follow-ups given a step, no more than the core takes', () => {
    const files = graphFilesOf([
      section('p/s1', 's1', [{ path: 'a.ts' }, { path: 'b.ts', reverted: true }]),
      section('p/', '', [{ path: 'c.ts' }]),
      section('external', null, [{ path: 'd.ts' }]),
    ]);
    expect(files).toEqual([sent('a.ts', 's1', false), sent('c.ts', '(follow-up)', false), sent('d.ts', null, true)]);
    const many = Array.from({ length: MAX_REVIEW_GRAPH_FILES + 1 }, (_, i) => ({ path: `f${i}.ts` }));
    expect(graphFilesOf([section('p/s1', 's1', many)])).toHaveLength(MAX_REVIEW_GRAPH_FILES);
  });

  it('sends a moved file as its old path going away with the content it moved and its new path appearing', () => {
    const moved = { key: 'p/s1', stepKey: 's1', files: [{ path: 'new.ts', renamedFrom: 'old.ts', reverted: false, before: 'h', after: 'h', added: 0, removed: 0 }] } as never;
    expect(graphFilesOf([moved])).toEqual([
      { path: 'old.ts', before: 'h', after: null, step: 's1', external: false, added: 0, removed: 0 },
      { path: 'new.ts', before: null, after: 'h', step: 's1', external: false, added: 0, removed: 0 },
    ]);
  });
});

describe('graphKey', () => {
  it('changes when anything the graph is drawn from changes, and not when the order does', () => {
    const file = { path: 'a.ts', before: 'b', after: 'a', step: 's1', external: false, added: 1, removed: 0 };
    const other = { ...file, path: 'z.ts' };
    const key = graphKey([file], 'p');
    expect(graphKey([file, other], 'p')).toBe(graphKey([other, file], 'p'));
    const variants = [{ path: 'b.ts' }, { before: 'b2' }, { after: 'a2' }, { step: 's2' }, { external: true }, { added: 2 }, { removed: 3 }];
    expect([...variants.map((change) => graphKey([{ ...file, ...change }], 'p')), graphKey([file], 'q')]).not.toContain(key);
  });
});

describe('stepOutcomes', () => {
  it('numbers the steps in the plan\'s order: done when done and it has files, partial when it has files and is not done, skipped when it has none', () => {
    const plan = {
      steps: [
        { key: 's2', order: 2, title: 'Two', status: 'active' },
        { key: 's1', order: 1, title: 'One', status: 'done' },
        { key: 's3', order: 3, title: 'Three', status: 'pending' },
      ],
    } as unknown as PlanView;
    const graph: ReviewGraph = {
      parts: [part('api', 'modified', { files: [
        { path: 'a', op: '~', added: 1, removed: 0, step: 's1', external: false },
        { path: 'b', op: '~', added: 1, removed: 0, step: 's2', external: false },
      ] })],
      links: [],
      partial: null,
    };
    expect(stepOutcomes(plan, graph).map((s) => [s.key, s.no, s.outcome])).toEqual([['s1', 1, 'done'], ['s2', 2, 'partial'], ['s3', 3, 'skipped']]);
  });
});

describe('totalsOf and partOfPath', () => {
  it('counts parts by status, flagged links with the part-level broken imports and the lines, and finds the part of a file', () => {
    const g: ReviewGraph = {
      parts: [
        part('a', 'created', { outside: true, files: [{ path: 'x.ts', op: '+', added: 5, removed: 0, step: null, external: false }] }),
        part('m', 'modified', { files: [{ path: 'y.ts', op: '~', added: 1, removed: 3, step: 's1', external: false }] }),
        part('b', 'missing'),
        part('c', 'deleted', { broken: [{ path: 'q', line: 1, text: 't' }] }),
      ],
      links: [link('a', 'b', 'unplanned'), link('a', 'c', 'broken')],
      partial: null,
    };
    expect(totalsOf(g)).toEqual({ created: 1, modified: 1, deleted: 1, missing: 1, outside: 1, unplanned: 1, broken: 2, added: 6, removed: 3 });
    expect([partOfPath(g, 'y.ts'), partOfPath(g, 'nope.ts')]).toEqual(['m', null]);
  });
});

describe('importedName', () => {
  it('reads the name an import line takes, in each syntax it knows, and none from a line that takes nothing', () => {
    const lines = [
      'from app.services.user_service import EmailTakenError, UserService',
      'from app.api import (',
      "import React, { useState, type FC as Component } from 'react';",
      "export { store } from './store';",
      "import * as path from 'node:path';",
      "import layout from './views/layout';",
      "const { join: joinPath } = require('node:path');",
      "const fs = require('node:fs');",
      'import app.core.security as security',
      'using Accounts.Services;',
      '#include "net/socket.h"',
      "import './polyfills';",
    ];
    expect(lines.map(importedName)).toEqual([
      'EmailTakenError +1', null, 'useState +1', 'store', 'path', 'layout', 'join', 'fs', 'security', 'Services', 'socket.h', null,
    ]);
  });
});

describe('fileOutsidePlan', () => {
  it('flags a file no step lists only when a plan exists and the file is not external', () => {
    expect(fileOutsidePlan({ step: null, external: false }, true)).toBe(true);
    expect(fileOutsidePlan({ step: null, external: false }, false)).toBe(false);
    expect(fileOutsidePlan({ step: null, external: true }, true)).toBe(false);
    expect(fileOutsidePlan({ step: 's1', external: false }, true)).toBe(false);
  });
});
