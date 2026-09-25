import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FileHashes, McpEntry, McpLevel, McpServerView, SettingsView } from '@ide/protocol';
import { entryHash, prepareEntry, fileHash, parseEntry, readMcpFile, readRawMcp, writeRawMcp, type RawMcpFile } from './config';

interface TrustRecord {
  projectPath: string;
  serverName: string;
  entryHash: string;
  approvedAt: number;
}

interface Ledger {
  mcpHash: string;
  trustHash: string;
}

interface Evaluated extends McpServerView {
  prepared: McpEntry | null;
}

export class McpSettingsError extends Error {}

export interface McpRegistryOptions {
  home: string;
  root: string;
  env?: NodeJS.ProcessEnv;
  builtins?: () => Record<string, McpEntry>;
  now?: () => number;
}

const PRIVATE_FILE_MODE = 0o600;

function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
  chmodSync(path, PRIVATE_FILE_MODE);
}

export class McpRegistry {
  private readonly options: McpRegistryOptions;
  private readonly idePath: string;
  private readonly projectPath: string;
  private readonly trustPath: string;
  private readonly ledgerPath: string;

  constructor(options: McpRegistryOptions) {
    this.options = options;
    this.idePath = join(options.home, 'mcp.json');
    this.projectPath = join(options.root, '.ide', 'mcp.json');
    this.trustPath = join(options.home, 'trust.json');
    this.ledgerPath = join(options.home, 'settings-ledger.json');
  }

  view(): SettingsView {
    const { servers, problems, externalEdits } = this.evaluate();
    return {
      servers: servers.map(({ name, level, entry, entryHash: hash, status, reason }) => ({ name, level, entry, entryHash: hash, status, reason })),
      problems,
      fileHashes: { ideServers: fileHash(this.idePath), trust: fileHash(this.trustPath) },
      externalEdits,
    };
  }

  sessionServers(): Record<string, McpEntry> {
    const servers: [string, McpEntry][] = [];
    for (const server of this.evaluate().servers) {
      if (server.status === 'ready' && server.prepared) servers.push([server.name, server.prepared]);
      if (server.status === 'shadowed') console.warn(`mcp: ignoring project server "${server.name}": ${server.reason}`);
    }
    return { ...Object.fromEntries(servers), ...this.options.builtins?.() };
  }

  save(level: McpLevel, name: string, raw: unknown, previousName: string | null): void {
    this.assertNoOutsideEdits(level);
    const entry = parseEntry(name, raw);
    if (typeof entry === 'string') throw new McpSettingsError(entry);
    const file = this.readRaw(this.pathOf(level));
    if (name !== previousName && Object.hasOwn(file.mcpServers, name)) {
      throw new McpSettingsError(`a ${level}-level server named "${name}" already exists`);
    }
    const servers = Object.entries(file.mcpServers).map(([key, value]): [string, unknown] => (key === previousName ? [name, entry] : [key, value]));
    if (!servers.some(([key]) => key === name)) servers.push([name, entry]);
    this.write(level, { ...file, mcpServers: Object.fromEntries(servers) });
    if (level === 'project') this.trust(name, entry, previousName);
  }

  remove(level: McpLevel, name: string): void {
    this.assertNoOutsideEdits(level);
    const file = this.readRaw(this.pathOf(level));
    if (!Object.hasOwn(file.mcpServers, name)) throw new McpSettingsError(`there is no ${level}-level server named "${name}"`);
    this.write(level, { ...file, mcpServers: Object.fromEntries(Object.entries(file.mcpServers).filter(([key]) => key !== name)) });
    if (level === 'project') this.writeTrust(this.trustRecords().filter((record) => !this.isOurs(record, name)));
  }

  approve(name: string, shownHash: string): void {
    this.assertNoOutsideEdits('project');
    const entry = readMcpFile(this.projectPath).servers.get(name);
    if (!entry) throw new McpSettingsError(`there is no valid project-level server named "${name}"`);
    if (entryHash(name, entry) !== shownHash) {
      throw new McpSettingsError(`the project-level server "${name}" changed after Settings showed it; review it again before approving`);
    }
    this.trust(name, entry, null);
  }

  confirmExternalEdits(shown: FileHashes): void {
    const current = { ideServers: fileHash(this.idePath), trust: fileHash(this.trustPath) };
    if (current.ideServers !== shown.ideServers || current.trust !== shown.trust) {
      throw new McpSettingsError('the files changed again after Settings showed them; review them again before confirming');
    }
    this.writeLedger({ mcpHash: current.ideServers, trustHash: current.trust });
  }

  private evaluate(): { servers: Evaluated[]; problems: string[]; externalEdits: SettingsView['externalEdits'] } {
    const ide = readMcpFile(this.idePath);
    const project = readMcpFile(this.projectPath);
    const ledger = this.readLedger();
    const edited = { ideServers: fileHash(this.idePath) !== ledger.mcpHash, trust: fileHash(this.trustPath) !== ledger.trustHash };
    const records = this.trustRecords().filter((record) => record.projectPath === this.options.root);
    const approvedBy = (name: string, entry: McpEntry) =>
      records.some((record) => record.serverName === name && record.entryHash === entryHash(name, entry));
    const servers: Evaluated[] = [];
    for (const [name, entry] of ide.servers) {
      const hash = entryHash(name, entry);
      servers.push(this.withEnv(edited.ideServers
        ? { name, level: 'ide', entry, entryHash: hash, status: 'unapproved', reason: `${this.idePath} was edited outside Settings`, prepared: null }
        : { name, level: 'ide', entry, entryHash: hash, status: 'ready', reason: null, prepared: null }));
    }
    const trustApproves: string[] = [];
    for (const [name, entry] of project.servers) {
      const hash = entryHash(name, entry);
      if (ide.servers.has(name)) {
        servers.push({ name, level: 'project', entry, entryHash: hash, status: 'shadowed', reason: 'an IDE-level server has the same name', prepared: null });
      } else if (!edited.trust && approvedBy(name, entry)) {
        servers.push(this.withEnv({ name, level: 'project', entry, entryHash: hash, status: 'ready', reason: null, prepared: null }));
      } else {
        if (edited.trust && approvedBy(name, entry)) trustApproves.push(name);
        const reason = edited.trust ? `${this.trustPath} was edited outside Settings` : 'not approved on this machine';
        servers.push({ name, level: 'project', entry, entryHash: hash, status: 'unapproved', reason, prepared: null });
      }
    }
    return {
      servers,
      problems: [...ide.problems.map((problem) => `IDE level: ${problem}`), ...project.problems.map((problem) => `project level: ${problem}`)],
      externalEdits: { ...edited, trustApproves },
    };
  }

  private withEnv(server: Evaluated): Evaluated {
    if (server.status !== 'ready') return server;
    const { entry, missing } = prepareEntry(server.entry, this.options.env ?? process.env);
    if (missing.length === 0) return { ...server, prepared: entry };
    return { ...server, status: 'missing-env', reason: `undefined environment variable${missing.length > 1 ? 's' : ''} ${missing.join(', ')}` };
  }

  private assertNoOutsideEdits(level: McpLevel): void {
    const ledger = this.readLedger();
    if (level === 'ide' && fileHash(this.idePath) !== ledger.mcpHash) {
      throw new McpSettingsError(`${this.idePath} was edited outside Settings; confirm those edits first`);
    }
    if (level === 'project' && fileHash(this.trustPath) !== ledger.trustHash) {
      throw new McpSettingsError(`${this.trustPath} was edited outside Settings; confirm those edits first`);
    }
  }

  private write(level: McpLevel, file: RawMcpFile): void {
    if (level === 'project') {
      this.assertNotLinked();
      writeRawMcp(this.projectPath, file);
      return;
    }
    writeRawMcp(this.idePath, file, PRIVATE_FILE_MODE);
    this.writeLedger({ mcpHash: fileHash(this.idePath) });
  }

  private assertNotLinked(): void {
    for (const path of [dirname(this.projectPath), this.projectPath]) {
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
        throw new McpSettingsError(`${path} is a symbolic link; the IDE does not write project settings through links`);
      }
    }
  }

  private trust(name: string, entry: McpEntry, previousName: string | null): void {
    const others = this.trustRecords().filter(
      (record) => !this.isOurs(record, name) && !(previousName !== null && this.isOurs(record, previousName)),
    );
    const approvedAt = (this.options.now ?? Date.now)();
    this.writeTrust([...others, { projectPath: this.options.root, serverName: name, entryHash: entryHash(name, entry), approvedAt }]);
  }

  private isOurs(record: TrustRecord, name: string): boolean {
    return record.projectPath === this.options.root && record.serverName === name;
  }

  private trustRecords(): TrustRecord[] {
    if (!existsSync(this.trustPath)) return [];
    try {
      const value = JSON.parse(readFileSync(this.trustPath, 'utf8')) as { records?: unknown };
      return Array.isArray(value.records) ? (value.records as TrustRecord[]) : [];
    } catch {
      return [];
    }
  }

  private writeTrust(records: TrustRecord[]): void {
    writePrivateJson(this.trustPath, { records });
    this.writeLedger({ trustHash: fileHash(this.trustPath) });
  }

  private readLedger(): Ledger {
    const fresh = { mcpHash: 'absent', trustHash: 'absent' };
    if (!existsSync(this.ledgerPath)) return fresh;
    try {
      return { ...fresh, ...(JSON.parse(readFileSync(this.ledgerPath, 'utf8')) as Partial<Ledger>) };
    } catch {
      return { mcpHash: 'unreadable', trustHash: 'unreadable' };
    }
  }

  private writeLedger(changes: Partial<Ledger>): void {
    writePrivateJson(this.ledgerPath, { ...this.readLedger(), ...changes });
  }

  private pathOf(level: McpLevel): string {
    return level === 'ide' ? this.idePath : this.projectPath;
  }

  private readRaw(path: string): RawMcpFile {
    const file = readRawMcp(path);
    if (typeof file === 'string') throw new McpSettingsError(`${file}; fix or delete it first`);
    return file;
  }
}
