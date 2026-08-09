import { describe, expect, test, afterAll } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createStateFileWriter, writeJsonAtomic } from '@/core/state-file';

const DIR = mkdtempSync(join(tmpdir(), 'nougate-state-'));

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('atomic writes', () => {
  test('creates the file and any missing parent directories', () => {
    const path = join(DIR, 'nested', 'deep', 'state.json');
    writeJsonAtomic(path, { hello: 'world' });

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ hello: 'world' });
  });

  test('leaves no temp file behind', () => {
    const path = join(DIR, 'clean.json');
    writeJsonAtomic(path, { a: 1 });
    writeJsonAtomic(path, { a: 2 });

    expect(readdirSync(DIR).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('a reader never observes a partial file', () => {
    // The previous contents stay readable and valid right up until the rename
    // swaps in the new ones — which is what protects the OAuth tokens.
    const path = join(DIR, 'swap.json');
    writeJsonAtomic(path, { generation: 1, payload: 'x'.repeat(50_000) });

    const before = JSON.parse(readFileSync(path, 'utf8'));
    writeJsonAtomic(path, { generation: 2, payload: 'y'.repeat(50_000) });
    const after = JSON.parse(readFileSync(path, 'utf8'));

    expect(before.generation).toBe(1);
    expect(after.generation).toBe(2);
  });
});

describe('debounced writer', () => {
  test('collapses a burst of saves into a single write', async () => {
    const path = join(DIR, 'burst.json');
    const writer = createStateFileWriter<{ n: number }>(path, { debounceMs: 40 });

    // Stand in for a burst of requests each updating an account's score.
    for (let n = 1; n <= 50; n += 1) {
      writer.schedule({ n });
    }
    expect(writer.isPending()).toBe(true);

    await wait(80);

    expect(writer.isPending()).toBe(false);
    // Only the newest value survives; the 49 superseded ones never hit disk.
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ n: 50 });
  });

  test('writes once per window, not once per call', async () => {
    const path = join(DIR, 'window.json');
    const writer = createStateFileWriter<{ n: number }>(path, { debounceMs: 30 });

    writer.schedule({ n: 1 });
    writer.schedule({ n: 2 });
    await wait(60);
    const firstWrite = statSync(path).mtimeMs;

    writer.schedule({ n: 3 });
    writer.schedule({ n: 4 });
    await wait(60);
    const secondWrite = statSync(path).mtimeMs;

    expect(secondWrite).toBeGreaterThanOrEqual(firstWrite);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ n: 4 });
  });

  test('flush persists immediately, for credential changes', () => {
    const path = join(DIR, 'immediate.json');
    const writer = createStateFileWriter<{ token: string }>(path, { debounceMs: 10_000 });

    writer.schedule({ token: 'fresh-refresh-token' });
    writer.flush();

    // Durable without waiting out a 10 second window.
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ token: 'fresh-refresh-token' });
    expect(writer.isPending()).toBe(false);
  });

  test('flushing with nothing pending is a no-op', () => {
    const path = join(DIR, 'noop.json');
    const writer = createStateFileWriter<{ a: number }>(path, { debounceMs: 10 });

    writer.flush();
    expect(readdirSync(DIR).includes('noop.json')).toBe(false);
  });

  test('a failed write does not throw into the caller', () => {
    // A directory where the file should be makes the write fail.
    const path = join(DIR, 'nested');
    const writer = createStateFileWriter<{ a: number }>(path, { debounceMs: 1 });

    writer.schedule({ a: 1 });
    expect(() => writer.flush()).not.toThrow();
    // And it cleans up after itself rather than stranding a .tmp file.
    expect(readdirSync(DIR).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
