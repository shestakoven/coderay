import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ControlMode, Policy, PolicyHashes, PolicyLevel, PolicyView } from '@ide/protocol';
import { projectDir } from '../home';
import { isRecord } from '../json';
import { fileHash, writeFileNoFollow } from '../mcp/config';

export const DEFAULT_POLICY: Policy = {
  mode: 'B',
  guarded: ['.env*', '.git/hooks/', '.git/config', '.git/info/', '.ide/mcp.json', '.claude/'],
  harness: ['.omc/'],
  outsideAllowed: ['~/.claude/plans/', '~/.claude/projects/*/memory/'],
  autoApproveMaxFiles: 3,
};

export class PolicyError extends Error {}

interface Ledger {
  ide: string;
  projects: Record<string, string>;
}

const MODES: readonly string[] = ['A', 'B', 'C'];
const LISTS = ['guarded', 'harness', 'outsideAllowed'] as const;
const MAX_ENTRIES = 200;
const MAX_ENTRY_CHARS = 300;
const MAX_AUTO_FILES = 50;
const PRIVATE_FILE_MODE = 0o600;
const MAX_EDITED_CHARS = 20_000;

export function parsePolicy(raw: unknown): Partial<Policy> | string {
  if (!isRecord(raw)) return 'the policy must be a JSON object';
  const policy: Partial<Policy> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'mode') {
      if (typeof value !== 'string' || !MODES.includes(value)) return '"mode" must be "A", "B" or "C"';
      policy.mode = value as ControlMode;
    } else if (key === 'autoApproveMaxFiles') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_AUTO_FILES) {
        return `"autoApproveMaxFiles" must be a whole number from 0 to ${MAX_AUTO_FILES}`;
      }
      policy.autoApproveMaxFiles = value;
    } else if ((LISTS as readonly string[]).includes(key)) {
      const list = parseList(key, value);
      if (typeof list === 'string') return list;
      policy[key as (typeof LISTS)[number]] = list;
    } else {
      return `unknown policy field "${key}"`;
    }
  }
  if (policy.outsideAllowed?.some((entry) => !entry.startsWith('/') && !entry.startsWith('~/'))) {
    return '"outsideAllowed" entries must be absolute paths or start with ~/';
  }
  return policy;
}

function parseList(key: string, value: unknown): string[] | string {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) return `"${key}" must be a list of at most ${MAX_ENTRIES} patterns`;
  const entries: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '' || entry.length > MAX_ENTRY_CHARS || entry.includes('\0')) {
      return `"${key}" entries must be non-empty text of at most ${MAX_ENTRY_CHARS} characters`;
    }
    if (!entries.includes(entry.trim())) entries.push(entry.trim());
  }
  return entries;
}

export class PolicyStore {
  private readonly idePath: string;
  private readonly projectPath: string;
  private readonly ledgerPath: string;
  private readonly key: string;

  constructor(options: { home: string; root: string }) {
    const dir = projectDir(options.home, options.root);
    this.idePath = join(options.home, 'policy.json');
    this.projectPath = join(dir, 'policy.json');
    this.ledgerPath = join(options.home, 'policy-ledger.json');
    this.key = basename(dir);
  }

  effective(): Policy {
    return this.view().effective;
  }

  view(): PolicyView {
    const ledger = this.readLedger();
    const hashes = { ide: fileHash(this.idePath), project: fileHash(this.projectPath) };
    const externalEdits = { ide: hashes.ide !== ledger.ide, project: hashes.project !== (ledger.projects[this.key] ?? 'absent') };
    const problems: string[] = [];
    const read = (level: PolicyLevel): Partial<Policy> => {
      const path = this.pathOf(level);
      if (externalEdits[level]) {
        problems.push(`${path} was edited outside Settings and is ignored until you confirm it: CodeRay level falls back to the defaults, the project level to CodeRay level`);
        return {};
      }
      return this.read(path, level === 'ide' ? 'CodeRay level' : 'project level', problems);
    };
    const ide = { ...DEFAULT_POLICY, ...read('ide') };
    const project = read('project');
    const edited = { ide: externalEdits.ide ? this.text(this.idePath) : null, project: externalEdits.project ? this.text(this.projectPath) : null };
    return { ide, project, effective: { ...ide, ...project }, hashes, externalEdits, edited, problems };
  }

  save(level: PolicyLevel, raw: unknown): void {
    const path = this.pathOf(level);
    if (this.view().externalEdits[level]) throw new PolicyError(`${path} was edited outside Settings; confirm that edit first`);
    const policy = parsePolicy(raw);
    if (typeof policy === 'string') throw new PolicyError(policy);
    const hash = writeFileNoFollow(path, `${JSON.stringify(policy, null, 2)}\n`, PRIVATE_FILE_MODE);
    const ledger = this.readLedger();
    this.writeLedger(level === 'ide' ? { ...ledger, ide: hash } : { ...ledger, projects: { ...ledger.projects, [this.key]: hash } });
  }

  confirmExternalEdits(shown: PolicyHashes): void {
    const current = { ide: fileHash(this.idePath), project: fileHash(this.projectPath) };
    if (current.ide !== shown.ide || current.project !== shown.project) {
      throw new PolicyError('the policy files changed again after Settings showed them; review them again before confirming');
    }
    const ledger = this.readLedger();
    this.writeLedger({ ide: shown.ide, projects: { ...ledger.projects, [this.key]: shown.project } });
  }

  private read(path: string, label: string, problems: string[]): Partial<Policy> {
    if (!existsSync(path)) return {};
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      problems.push(`${label}: ${path} is not valid JSON`);
      return {};
    }
    const policy = parsePolicy(raw);
    if (typeof policy === 'string') {
      problems.push(`${label}: ${policy}`);
      return {};
    }
    return policy;
  }

  private text(path: string): string {
    try {
      return readFileSync(path, 'utf8').slice(0, MAX_EDITED_CHARS);
    } catch {
      return '(the file was deleted)';
    }
  }

  private pathOf(level: PolicyLevel): string {
    return level === 'ide' ? this.idePath : this.projectPath;
  }

  private readLedger(): Ledger {
    if (!existsSync(this.ledgerPath)) return { ide: 'absent', projects: {} };
    try {
      const value = JSON.parse(readFileSync(this.ledgerPath, 'utf8')) as Partial<Ledger>;
      return { ide: typeof value.ide === 'string' ? value.ide : 'absent', projects: isRecord(value.projects) ? (value.projects as Record<string, string>) : {} };
    } catch {
      // Never equal to fileHash's own sentinels, so a corrupt ledger reads as an outside edit of both levels.
      return { ide: 'corrupt-ledger', projects: {} };
    }
  }

  private writeLedger(ledger: Ledger): void {
    writeFileNoFollow(this.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, PRIVATE_FILE_MODE);
  }
}
