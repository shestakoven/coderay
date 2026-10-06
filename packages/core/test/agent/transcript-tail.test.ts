import { appendFileSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { TranscriptTail } from '../../src/agent/transcript-tail';
import { tempDir, waitFor } from '../helpers';

const POLL_MS = 10;
const quiet = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

function follower(initial?: string) {
  const path = join(tempDir('ide-transcript-'), 'claude.jsonl');
  if (initial !== undefined) writeFileSync(path, initial);
  const lines: string[] = [];
  const tail = new TranscriptTail((line) => lines.push(line), POLL_MS);
  onTestFinished(() => tail.stop());
  return { path, lines, tail };
}

describe('TranscriptTail', () => {
  it('reports the lines appended after it started following, not those already in the file', async () => {
    const { path, lines, tail } = follower('old one\nold two\n');
    tail.follow(path);
    appendFileSync(path, 'new\n');
    await waitFor(() => lines.length > 0, 'a line');
    await quiet();
    expect(lines).toEqual(['new']);
  });

  it('reports several appended lines in order', async () => {
    const { path, lines, tail } = follower('');
    tail.follow(path);
    appendFileSync(path, 'a\nb\nc\n');
    await waitFor(() => lines.length === 3, 'three lines');
    expect(lines).toEqual(['a', 'b', 'c']);
  });

  it('reports lines written in separate appends, each once', async () => {
    const { path, lines, tail } = follower('');
    tail.follow(path);
    appendFileSync(path, 'a\n');
    await waitFor(() => lines.length === 1, 'the first line');
    appendFileSync(path, 'b\n');
    await waitFor(() => lines.length === 2, 'the second line');
    await quiet();
    expect(lines).toEqual(['a', 'b']);
  });

  it('holds a line back until its end has been written', async () => {
    const { path, lines, tail } = follower('');
    tail.follow(path);
    appendFileSync(path, '{"type":"user","mes');
    await quiet();
    expect(lines).toEqual([]);
    appendFileSync(path, 'sage":1}\n');
    await waitFor(() => lines.length === 1, 'the whole line');
    expect(lines).toEqual(['{"type":"user","message":1}']);
  });

  it('reports a line that arrives in three writes as one line', async () => {
    const { path, lines, tail } = follower('');
    tail.follow(path);
    for (const piece of ['par', 'tial ', 'line']) {
      appendFileSync(path, piece);
      await quiet(40);
    }
    expect(lines).toEqual([]);
    appendFileSync(path, '\n');
    await waitFor(() => lines.length === 1, 'the line');
    expect(lines).toEqual(['partial line']);
  });

  it('reports the complete lines of a write that ends in the middle of the next one', async () => {
    const { path, lines, tail } = follower('');
    tail.follow(path);
    appendFileSync(path, 'one\ntw');
    await waitFor(() => lines.length === 1, 'the complete line');
    appendFileSync(path, 'o\n');
    await waitFor(() => lines.length === 2, 'the rest');
    expect(lines).toEqual(['one', 'two']);
  });

  it('keeps a multi-byte character intact when a read ends in the middle of it', async () => {
    const { path, lines, tail } = follower('');
    tail.follow(path);
    const bytes = Buffer.from('привет, 世界\n');
    const middleOfAChar = bytes.indexOf(Buffer.from('世')) + 1;
    appendFileSync(path, bytes.subarray(0, middleOfAChar));
    await quiet();
    appendFileSync(path, bytes.subarray(middleOfAChar));
    await waitFor(() => lines.length === 1, 'the line');
    expect(lines).toEqual(['привет, 世界']);
  });

  it('keeps a four-byte character intact when it is written one byte at a time', async () => {
    const { path, lines, tail } = follower('');
    tail.follow(path);
    for (const byte of Buffer.from('ok 😀\n')) {
      appendFileSync(path, Buffer.from([byte]));
      await quiet(25);
    }
    await waitFor(() => lines.length === 1, 'the line');
    expect(lines).toEqual(['ok 😀']);
  });

  it('starts over from the beginning when the file becomes shorter than what it has read', async () => {
    const { path, lines, tail } = follower('a long first line that is already in the file\n');
    tail.follow(path);
    appendFileSync(path, 'second line, longer than the next one\n');
    await waitFor(() => lines.length === 1, 'the second line');
    writeFileSync(path, 'fresh\n');
    await waitFor(() => lines.length === 2, 'the line of the new file');
    expect(lines).toEqual(['second line, longer than the next one', 'fresh']);
  });

  it('starts over after the file is emptied and written again', async () => {
    const { path, lines, tail } = follower('');
    tail.follow(path);
    appendFileSync(path, 'before the cut\n');
    await waitFor(() => lines.length === 1, 'the first line');
    truncateSync(path, 0);
    await quiet(60);
    appendFileSync(path, 'after\n');
    await waitFor(() => lines.length === 2, 'the line after the cut');
    expect(lines).toEqual(['before the cut', 'after']);
  });

  it('reads a file that does not exist yet from its first line once it appears', async () => {
    const { path, lines, tail } = follower();
    tail.follow(path);
    await quiet(40);
    writeFileSync(path, 'a\nb\n');
    await waitFor(() => lines.length === 2, 'both lines');
    expect(lines).toEqual(['a', 'b']);
  });

  it('reports nothing once it has been stopped', async () => {
    const { path, lines, tail } = follower('');
    tail.follow(path);
    appendFileSync(path, 'a\n');
    await waitFor(() => lines.length === 1, 'the line');
    tail.stop();
    appendFileSync(path, 'b\n');
    await quiet();
    expect(lines).toEqual(['a']);
  });

  it('follows the same file again once it has been stopped, from where the file ends then', async () => {
    const { path, lines, tail } = follower('');
    tail.follow(path);
    tail.stop();
    appendFileSync(path, 'while stopped\n');
    tail.follow(path);
    appendFileSync(path, 'after\n');
    await waitFor(() => lines.length > 0, 'a line');
    await quiet();
    expect(lines).toEqual(['after']);
  });

  it('keeps one timer while it follows, however often it is asked to, and none once it has been stopped', () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { path, tail } = follower('');
    expect(vi.getTimerCount()).toBe(0);
    tail.follow(path);
    tail.follow(path);
    expect(vi.getTimerCount()).toBe(1);
    tail.follow(join(tempDir('ide-transcript-'), 'other.jsonl'));
    expect(vi.getTimerCount()).toBe(1);
    tail.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not lose what is not read yet when asked to follow the same file again', async () => {
    const { path, lines, tail } = follower('');
    tail.follow(path);
    appendFileSync(path, 'kept\n');
    tail.follow(path);
    await waitFor(() => lines.length === 1, 'the line');
    await quiet();
    expect(lines).toEqual(['kept']);
  });

  it('follows another file from its end and leaves the first one alone', async () => {
    const first = follower('');
    const second = join(tempDir('ide-transcript-'), 'other.jsonl');
    writeFileSync(second, 'already there\n');
    first.tail.follow(first.path);
    first.tail.follow(second);
    appendFileSync(first.path, 'from the first\n');
    appendFileSync(second, 'from the second\n');
    await waitFor(() => first.lines.length > 0, 'a line');
    await quiet();
    expect(first.lines).toEqual(['from the second']);
  });

  describe('when asked to follow another file', () => {
    it('reports the lines the old file got since the last poll before it switches, without waiting for a poll', () => {
      const first = follower('');
      const second = join(tempDir('ide-transcript-'), 'other.jsonl');
      writeFileSync(second, 'already there\n');
      first.tail.follow(first.path);
      appendFileSync(first.path, 'just before the switch\nand another\n');
      first.tail.follow(second);
      expect(first.lines).toEqual(['just before the switch', 'and another']);
    });

    it('reports those lines before the lines of the new file, which it then follows from its end', async () => {
      const first = follower('');
      const second = join(tempDir('ide-transcript-'), 'other.jsonl');
      writeFileSync(second, 'already there\n');
      first.tail.follow(first.path);
      appendFileSync(first.path, 'from the old file\n');
      first.tail.follow(second);
      appendFileSync(second, 'from the new file\n');
      await waitFor(() => first.lines.length === 2, 'both lines');
      await quiet();
      expect(first.lines).toEqual(['from the old file', 'from the new file']);
    });

    it('does not report a line of the old file that is still being written when it switches', async () => {
      const first = follower('');
      const second = join(tempDir('ide-transcript-'), 'other.jsonl');
      writeFileSync(second, '');
      first.tail.follow(first.path);
      appendFileSync(first.path, 'a whole line\nhalf a li');
      first.tail.follow(second);
      appendFileSync(first.path, 'ne\n');
      await quiet();
      expect(first.lines).toEqual(['a whole line']);
    });

    it('reports nothing more from the old file once switched', async () => {
      const first = follower('');
      const second = join(tempDir('ide-transcript-'), 'other.jsonl');
      writeFileSync(second, '');
      first.tail.follow(first.path);
      first.tail.follow(second);
      appendFileSync(first.path, 'too late\n');
      await quiet();
      expect(first.lines).toEqual([]);
    });

    it('reports nothing for the old file when it never got a line, and keeps one timer', () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const first = follower('');
      first.tail.follow(first.path);
      first.tail.follow(join(tempDir('ide-transcript-'), 'other.jsonl'));
      expect([first.lines, vi.getTimerCount()]).toEqual([[], 1]);
    });

    it('does not read anything when asked to follow the same file again', () => {
      const first = follower('');
      first.tail.follow(first.path);
      appendFileSync(first.path, 'not read yet\n');
      first.tail.follow(first.path);
      expect(first.lines).toEqual([]);
    });
  });
});
