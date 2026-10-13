import { describe, expect, it } from 'vitest';
import type { PlanView, ReviewGraph, ReviewPart } from '@ide/protocol';
import { fileOutsidePlan, focusOf, graphFilesOf, graphKey, importedName, partOfPath, stepOutcomes, targetKey, totalsOf, visibleMap } from '../src/history/review-map/review-map-model';

const part = (id: string, status: ReviewPart['status'], extra: Partial<ReviewPart> = {}): ReviewPart =>
  ({ id, title: id, status, steps: [], outside: false, files: [], broken: [], ...extra });

const graph: ReviewGraph = {
  parts: [part('api', 'modified'), part('db', 'untouched'), part('log', 'untouched'), part('old', 'untouched')],
  links: [
    { from: 'api', to: 'db', state: 'existing', count: 1, evidence: [] },
    { from: 'old', to: 'api', state: 'broken', count: 1, evidence: [] },
    { from: 'db', to: 'log', state: 'existing', count: 1, evidence: [] },
  ],
  partial: null,
};

describe('visibleMap', () => {
  it('without context keeps unchanged parts only where a flagged link ends in them, and the links between what is shown', () => {
    const view = visibleMap(graph, false);
    expect(view.parts.map((p) => p.id)).toEqual(['api', 'old']);
    expect(view.links.map((l) => l.index)).toEqual([1]);
  });

  it('with context shows every part and keeps the index of each link in the graph', () => {
    const view = visibleMap(graph, true);
    expect(view.parts).toHaveLength(4);
    expect(view.links.map((l) => l.index)).toEqual([0, 1, 2]);
  });
});

describe('focusOf', () => {
  it('a part focuses itself and its neighbours through the links that touch it', () => {
    const focus = focusOf(visibleMap(graph, true), { t: 'part', id: 'api' })!;
    expect([...focus.parts].sort()).toEqual(['api', 'db', 'old']);
    expect([...focus.links].sort()).toEqual([0, 1]);
  });

  it('a link focuses its two ends and nothing else', () => {
    const focus = focusOf(visibleMap(graph, true), { t: 'link', from: 'db', to: 'log' })!;
    expect([...focus.parts].sort()).toEqual(['db', 'log']);
    expect([...focus.links]).toEqual([2]);
  });

  it('is nothing for a part the view does not show', () => {
    expect(focusOf(visibleMap(graph, false), { t: 'part', id: 'db' })).toBeNull();
  });
});

describe('graphFilesOf', () => {
  const section = (files: { path: string; reverted: boolean }[], stepKey: string | null = 's1', key = 'p/s1') =>
    ({ key, stepKey, files: files.map((f) => ({ ...f, before: 'b', after: 'a', added: 1, removed: 0 })) }) as never;

  it('leaves out files the user reverted and carries the step of the section', () => {
    const files = graphFilesOf([section([{ path: 'a.ts', reverted: false }, { path: 'b.ts', reverted: true }])]);
    expect(files).toEqual([{ path: 'a.ts', before: 'b', after: 'a', step: 's1', external: false, added: 1, removed: 0 }]);
  });

  it('marks files of the external section as external with no step', () => {
    const files = graphFilesOf([section([{ path: 'c.ts', reverted: false }], null, 'external')]);
    expect(files[0]).toMatchObject({ step: null, external: true });
  });

  it('gives a follow-up file a step of its own, since the request refuses an empty one', () => {
    const files = graphFilesOf([section([{ path: 'd.ts', reverted: false }], '', 'p1/')]);
    expect(files[0]).toMatchObject({ step: '(follow-up)', external: false });
  });
});

describe('graphKey', () => {
  const file = { path: 'a.ts', before: 'b', after: 'a', step: 's1', external: false, added: 1, removed: 0 };
  it('changes when a hash or the plan changes, and not when the order does', () => {
    const other = { ...file, path: 'z.ts' };
    expect(graphKey([file, other], 'p')).toBe(graphKey([other, file], 'p'));
    expect(graphKey([file], 'p')).not.toBe(graphKey([{ ...file, after: 'a2' }], 'p'));
    expect(graphKey([file], 'p')).not.toBe(graphKey([file], 'q'));
    expect(graphKey([file], 'p')).not.toBe(graphKey([{ ...file, added: 2 }], 'p'));
    expect(graphKey([file], 'p')).not.toBe(graphKey([{ ...file, removed: 3 }], 'p'));
  });
});

describe('stepOutcomes', () => {
  const plan = {
    steps: [
      { key: 's1', order: 1, title: 'One', status: 'done' },
      { key: 's2', order: 2, title: 'Two', status: 'active' },
      { key: 's3', order: 3, title: 'Three', status: 'pending' },
    ],
  } as unknown as PlanView;
  const withFiles = { ...graph, parts: [part('api', 'modified', { files: [
    { path: 'a', op: '~', added: 1, removed: 0, step: 's1', external: false },
    { path: 'b', op: '~', added: 1, removed: 0, step: 's2', external: false },
  ] })] };

  it('is done when the step is done and has files, partial when it has files and is not done, skipped when it has none', () => {
    expect(stepOutcomes(plan, withFiles).map((s) => [s.no, s.outcome])).toEqual([[1, 'done'], [2, 'partial'], [3, 'skipped']]);
  });
});

describe('totalsOf and partOfPath and targetKey', () => {
  it('counts parts by status, flagged links and the part-level broken imports, and finds the part of a file', () => {
    const g: ReviewGraph = {
      parts: [part('a', 'created', { outside: true, files: [{ path: 'x.ts', op: '+', added: 5, removed: 0, step: null, external: false }] }), part('b', 'missing'), part('c', 'deleted', { broken: [{ path: 'q', line: 1, text: 't' }] })],
      links: [{ from: 'a', to: 'b', state: 'unplanned', count: 1, evidence: [] }, { from: 'a', to: 'c', state: 'broken', count: 1, evidence: [] }],
      partial: null,
    };
    expect(totalsOf(g)).toMatchObject({ created: 1, missing: 1, deleted: 1, outside: 1, unplanned: 1, broken: 2, added: 5 });
    expect(partOfPath(g, 'x.ts')).toBe('a');
    expect(partOfPath(g, 'nope.ts')).toBeNull();
    expect(targetKey({ t: 'link', from: 'a', to: 'b' })).toBe('l:a>b');
  });
});

describe('importedName', () => {
  it.each([
    ['from app.utils.validators import validate_email_domain', 'validate_email_domain'],
    ['from app.services.user_service import EmailTakenError, UserService', 'EmailTakenError +1'],
    ['from . import db as database', 'db'],
    ['from app.api import (', null],
    ['import app.core.security as security', 'security'],
    ["import { client, type Auth as A } from '../api/client';", 'client +1'],
    ["import React, { useState } from 'react';", 'useState'],
    ["import * as path from 'node:path';", 'path'],
    ["import layout from './views/layout';", 'layout'],
    ["export { store } from './state/store';", 'store'],
    ["const { join: joinPath } = require('node:path');", 'join'],
    ["const fs = require('node:fs');", 'fs'],
    ['using Accounts.Services;', 'Services'],
    ['import Foundation', 'Foundation'],
    ['#include "net/socket.h"', 'socket.h'],
    ["import './polyfills';", null],
    ['db.query(sql)', null],
  ])('reads %j as %j', (line, name) => {
    expect(importedName(line)).toBe(name);
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
