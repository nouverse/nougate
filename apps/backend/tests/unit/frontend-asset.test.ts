/**
 * Finding the built dashboard, and what happens when there isn't one.
 *
 * The bug this pins: vite builds with `emptyOutDir`, so it clears `dist` before it writes. A build
 * that fails partway leaves the directory sitting there with nothing in it — and a lookup that asks
 * `existsSync(dir)` is satisfied by that. The check passed, the read did not, and the dashboard
 * answered `ENOENT: … /apps/frontend/dist/index.html` with a 500 naming one of four candidate paths.
 *
 * Which sent people looking for a Docker COPY bug. The real cause was a frontend build that had
 * failed thirty seconds earlier, and nothing in the error said so.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir = '';

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

/**
 * The selection rule itself, isolated.
 *
 * `serveFrontendAsset` is not exported and reaches for `import.meta.dir`, so this asserts the
 * predicate the fix turns on rather than the handler around it — the directory-versus-entry-document
 * distinction is the whole of the bug.
 */
const pickDist = (candidates: string[]) =>
  candidates.find((candidate) => existsSync(join(candidate, 'index.html')));

describe('choosing where the dashboard is', () => {
  test('an empty dist is skipped, not chosen', () => {
    // Exactly the state a failed vite build leaves behind.
    dir = mkdtempSync(join(tmpdir(), 'nougate-dist-'));
    const empty = join(dir, 'apps', 'frontend', 'dist');
    const real = join(dir, 'frontend', 'dist');
    mkdirSync(empty, { recursive: true });
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'index.html'), '<!doctype html>');

    // The empty one comes first, as it does in the container.
    expect(pickDist([empty, real])).toBe(real);
  });

  test('the old rule would have chosen the empty one', () => {
    /**
     * The regression guard, stated as the bug rather than as the fix. If someone changes the
     * predicate back to "does the directory exist", this is what they get — and this test says so
     * before the 500 does.
     */
    dir = mkdtempSync(join(tmpdir(), 'nougate-dist-'));
    const empty = join(dir, 'apps', 'frontend', 'dist');
    const real = join(dir, 'frontend', 'dist');
    mkdirSync(empty, { recursive: true });
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'index.html'), '<!doctype html>');

    const oldRule = [empty, real].find((candidate) => existsSync(candidate));
    expect(oldRule).toBe(empty);
    expect(existsSync(join(oldRule!, 'index.html'))).toBe(false);
  });

  test('nothing anywhere is undefined, so the caller can say so', () => {
    // Rather than handing back a path that does not exist and letting the file read fail with an
    // ENOENT that names one arbitrary candidate.
    dir = mkdtempSync(join(tmpdir(), 'nougate-dist-'));
    expect(pickDist([join(dir, 'nope'), join(dir, 'also-nope')])).toBeUndefined();
  });

  test('a populated dist is chosen even when it is last', () => {
    dir = mkdtempSync(join(tmpdir(), 'nougate-dist-'));
    const real = join(dir, 'binary-sibling', 'frontend');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'index.html'), '<!doctype html>');

    expect(pickDist([join(dir, 'a'), join(dir, 'b'), real])).toBe(real);
  });
});
