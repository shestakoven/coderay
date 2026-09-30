import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export class BodyError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function isAgentRequest(req: IncomingMessage, secret: string): boolean {
  if (secret === '') return false;
  const header = req.headers.authorization ?? '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '');
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Drains the whole body even when it is too large, so the caller can still answer with a status.
export function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (size > limit) {
        reject(new BodyError(413, 'request body too large'));
        return;
      }
      if (size === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new BodyError(400, 'request body is not JSON'));
      }
    });
  });
}

export function requireSecret(secret: string): void {
  if (secret === '') throw new Error('the agent secret must not be empty');
}
