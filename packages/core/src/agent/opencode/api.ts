import { request, type IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { isRecord, parseJson } from '../../json';

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export interface SseEvent {
  type: string;
  properties: Record<string, unknown>;
}

export interface OpencodeClient {
  /** `timeoutMs` 0 waits as long as the answer takes (a `/command` answers when its turn ends). */
  get<T>(path: string, timeoutMs?: number): Promise<T>;
  post<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T>;
  put<T>(path: string, body: unknown, timeoutMs?: number): Promise<T>;
  del<T>(path: string, timeoutMs?: number): Promise<T>;
  /** One GET /event stream; ends when the server closes it or `signal` aborts. */
  events(onEvent: (event: SseEvent) => void, signal: AbortSignal): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
// A header carries printable ASCII only; another directory goes in the query parameter opencode reads first.
const HEADER_SAFE = /^[\x20-\x7e]*$/;
const FRAME_END = /\r?\n\r?\n/;

function detail(body: unknown): string {
  if (!isRecord(body)) return '';
  const text = typeof body.error === 'string' ? body.error : isRecord(body.data) && typeof body.data.message === 'string' ? body.data.message : body.message;
  return typeof text === 'string' && text !== '' ? `: ${text}` : '';
}

function readBody(res: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      text += chunk;
    });
    res.on('end', () => {
      const value = text === '' ? undefined : parseJson(text);
      resolve(text !== '' && value === undefined ? text : value);
    });
    res.on('error', reject);
  });
}

// node:http rather than fetch: fetch gives up on a response's headers after 300 s, and a `/command` answers only when its turn ends (Q10).
export function opencodeClient(base: string, password: string, directory: string): OpencodeClient {
  const origin = new URL(base);
  const inHeader = HEADER_SAFE.test(directory);
  const headers: Record<string, string> = {
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
    ...(inHeader ? { 'x-opencode-directory': directory } : {}),
  };
  const target = (path: string): string => {
    if (inHeader) return path;
    const url = new URL(path, origin);
    url.searchParams.set('directory', directory);
    return `${url.pathname}${url.search}`;
  };
  const open = (method: string, path: string, extra: Record<string, string | number> = {}) =>
    request({ hostname: origin.hostname, port: origin.port, method, path: target(path), headers: { ...headers, ...extra } });

  function call<T>(method: string, path: string, body: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = open(method, path, payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      let timedOut = false;
      const timer = timeoutMs > 0 ? setTimeout(() => {
        timedOut = true;
        req.destroy();
      }, timeoutMs) : undefined;
      const fail = (error: Error): void => {
        clearTimeout(timer);
        reject(timedOut ? new Error(`opencode did not answer ${method} ${path} within ${timeoutMs / 1000} s`) : error instanceof ApiError ? error : new Error(`opencode could not be reached for ${method} ${path}: ${error.message}`));
      };
      req.on('response', (res) => {
        readBody(res).then((value) => {
          clearTimeout(timer);
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve(value as T);
          else fail(new ApiError(status, value, `opencode answered ${status} to ${method} ${path}${detail(value)}`));
        }, fail);
      });
      req.on('error', fail);
      req.end(payload);
    });
  }

  return {
    get: (path, timeoutMs) => call('GET', path, undefined, timeoutMs),
    post: (path, body, timeoutMs) => call('POST', path, body, timeoutMs),
    put: (path, body, timeoutMs) => call('PUT', path, body, timeoutMs),
    del: (path, timeoutMs) => call('DELETE', path, undefined, timeoutMs),
    events(onEvent, signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) return resolve();
        const req = open('GET', '/event', { accept: 'text/event-stream' });
        const abort = (): void => {
          req.destroy();
        };
        const finish = (error?: unknown): void => {
          signal.removeEventListener('abort', abort);
          req.destroy();
          if (error === undefined || signal.aborted) resolve();
          else reject(error);
        };
        signal.addEventListener('abort', abort, { once: true });
        req.on('response', (res) => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            readBody(res).then((value) => finish(new ApiError(status, value, `opencode answered ${status} to GET /event${detail(value)}`)), finish);
            return;
          }
          readSse(Readable.toWeb(res) as ReadableStream<Uint8Array>, onEvent, signal).then(() => finish(), finish);
        });
        req.on('error', finish);
        req.end();
      });
    },
  };
}

function parseFrame(frame: string): SseEvent | null {
  const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice('data:'.length).replace(/^ /, '')).join('\n');
  // A frame of comments only is a keep-alive.
  if (data === '') return null;
  const value = parseJson(data);
  if (isRecord(value) && typeof value.type === 'string') return { type: value.type, properties: isRecord(value.properties) ? value.properties : {} };
  console.warn('opencode: unreadable event');
  return null;
}

/** Splits an SSE body into events; exported for the tests and the idecore keep-alive test. */
export async function readSse(body: ReadableStream<Uint8Array>, onEvent: (event: SseEvent) => void, signal: AbortSignal): Promise<void> {
  const reader = body.getReader();
  const stop = (): void => {
    reader.cancel().catch(() => {});
  };
  if (signal.aborted) return stop();
  signal.addEventListener('abort', stop, { once: true });
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || signal.aborted) return;
      buffer += decoder.decode(value, { stream: true });
      for (let end = FRAME_END.exec(buffer); end !== null && !signal.aborted; end = FRAME_END.exec(buffer)) {
        const event = parseFrame(buffer.slice(0, end.index));
        buffer = buffer.slice(end.index + end[0].length);
        if (event) onEvent(event);
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    signal.removeEventListener('abort', stop);
  }
}
