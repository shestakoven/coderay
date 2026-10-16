import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { isRecord, parseJson } from '../../json';
import type { RequestId } from './protocol';

export class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Incoming {
  method: string;
  params: unknown;
}

export interface IncomingRequest extends Incoming {
  id: RequestId;
}

export interface RpcHandlers {
  notification(message: Incoming): void;
  /** A request the app-server makes of CodeRay: answered later with `reply` or `fail`, or never. */
  request(message: IncomingRequest): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 60_000;

const isId = (value: unknown): value is RequestId => typeof value === 'string' || typeof value === 'number';

/** JSON-RPC over the app-server's stdio, one JSON object per line. */
export class JsonRpc {
  private readonly output: Writable;
  private readonly handlers: RpcHandlers;
  private readonly pending = new Map<RequestId, Pending>();
  private nextId = 1;
  private ended: Error | null = null;

  constructor(input: Readable, output: Writable, handlers: RpcHandlers) {
    this.output = output;
    this.handlers = handlers;
    createInterface({ input }).on('line', (line) => this.receive(line));
    input.once('close', () => this.end(new Error('The app-server closed its output.')));
    input.once('end', () => this.end(new Error('The app-server closed its output.')));
    // A write after the app-server exited fails with EPIPE; the exit itself is reported elsewhere.
    output.on('error', () => {});
  }

  request<T>(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.ended) return Promise.reject(this.ended);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`The app-server did not answer ${method} in ${timeoutMs / 1000} s.`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  reply(id: RequestId, result: unknown): void {
    this.write({ id, result });
  }

  fail(id: RequestId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  end(reason: Error): void {
    if (this.ended) return;
    this.ended = reason;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(reason);
    }
  }

  // The verification runs sent "jsonrpc": "2.0" on every message (codex answers without it), so CodeRay sends the wire they verified.
  private write(message: object): void {
    if (this.ended || !this.output.writable) return;
    this.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  private receive(line: string): void {
    const message = parseJson(line);
    if (!isRecord(message)) return;
    try {
      if (typeof message.method === 'string') {
        if (isId(message.id)) this.handlers.request({ id: message.id, method: message.method, params: message.params });
        else this.handlers.notification({ method: message.method, params: message.params });
        return;
      }
      if (!isId(message.id)) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      const error = message.error;
      if (isRecord(error)) pending.reject(new RpcError(typeof error.code === 'number' ? error.code : 0, typeof error.message === 'string' ? error.message : 'error'));
      else pending.resolve(message.result);
    } catch (error) {
      console.error('codex: could not handle a message from the app-server', error);
    }
  }
}
