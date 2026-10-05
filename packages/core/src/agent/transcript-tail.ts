import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const POLL_MS = 200;
const MAX_READ_BYTES = 4 * 1024 * 1024;

// Follows the lines claude appends to its transcript, from the moment it is followed.
export class TranscriptTail {
  private readonly onLine: (line: string) => void;
  private readonly pollMs: number;
  private path: string | null = null;
  private offset = 0;
  private partial = '';
  private decoder = new StringDecoder('utf8');
  private timer: NodeJS.Timeout | undefined;

  constructor(onLine: (line: string) => void, pollMs = POLL_MS) {
    this.onLine = onLine;
    this.pollMs = pollMs;
  }

  follow(path: string): void {
    if (path === this.path) return;
    this.stop();
    this.path = path;
    this.offset = sizeOf(path);
    this.timer = setInterval(() => this.read(), this.pollMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.path = null;
    this.partial = '';
    this.decoder = new StringDecoder('utf8');
  }

  private read(): void {
    if (this.path === null) return;
    const size = sizeOf(this.path);
    if (size < this.offset) this.offset = 0;
    if (size === this.offset) return;
    const length = Math.min(size - this.offset, MAX_READ_BYTES);
    const buffer = Buffer.alloc(length);
    let fd: number | undefined;
    try {
      fd = openSync(this.path, 'r');
      const read = readSync(fd, buffer, 0, length, this.offset);
      this.offset += read;
      const lines = (this.partial + this.decoder.write(buffer.subarray(0, read))).split('\n');
      this.partial = lines.pop() ?? '';
      for (const line of lines) if (line.trim() !== '') this.onLine(line);
    } catch (error) {
      console.error('agent: could not read claude\'s transcript', error);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
