import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// node:sqlite prints an ExperimentalWarning on first load in Node 24; the store is its only user.
const emitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (!String(warning).includes('SQLite')) (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
}) as typeof process.emitWarning;
const sqlite = require('node:sqlite') as typeof import('node:sqlite');
process.emitWarning = emitWarning;

export const { DatabaseSync } = sqlite;
