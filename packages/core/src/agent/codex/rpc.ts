import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { isRecord, parseJson } from '../../json';
import type { RequestId } from './protocol';

export class RpcError extends Error {
  override readonly name = 'RpcError';
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
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
const INTERNAL_ERROR = -32603;

const isId = (value: unknown): value is RequestId => typeof value === 'string' || typeof value === 'number';

/** JSON-RPC over the app-server's stdio, one JSON object per line. Its owner ends it with the reason the app-server stopped. */
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
    // A write after the app-server exited fails with EPIPE; the exit itself is reported through `end`.
    output.on('error', () => {});
  }

  request<T>(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.ended) return Promise.reject(this.ended);
    if (!this.output.writable) return Promise.reject(new Error(`The app-server no longer reads its input: ${method} was not sent.`));
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

  /** Rejects every request still waiting, and every later one, with `reason`; the first reason given stays. */
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
    if (typeof message.method === 'string') {
      const { method, params } = message;
      const id = isId(message.id) ? message.id : null;
      try {
        if (id === null) this.handlers.notification({ method, params });
        else this.handlers.request({ id, method, params });
      } catch (error) {
        console.error(`codex: could not handle ${method} from the app-server`, error);
        // The app-server waits for every request it makes: an answer that grants nothing, never silence.
        if (id !== null) this.fail(id, INTERNAL_ERROR, `CodeRay could not handle ${method}.`);
      }
      return;
    }
    if (!isId(message.id)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    const error = message.error;
    if (isRecord(error)) pending.reject(new RpcError(typeof error.code === 'number' ? error.code : 0, typeof error.message === 'string' ? error.message : 'error', error.data));
    else pending.resolve(message.result);
  }
}
