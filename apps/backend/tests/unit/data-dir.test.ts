/**
 * Where nougate keeps its state when something hosts it — `NOUGATE_HOME` beats every guess.
 *
 * Nouride runs nougate in its own process and sets `NOUGATE_HOME` to its install root so the gateway's
 * database lands beside its own, in the one volume an operator mounts. `getDataDir()` used to check
 * `/app/data` first — this image's own layout — and the Nouride image happened to have that directory
 * too. So in a Nouride container every account and provider was written to a path no volume covered,
 * and a recreate wiped them: the gateway came back with a fresh admin and no providers.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { dataPath, getDataDir, getProjectRoot } from '../../src/core/paths';

const previous = process.env.NOUGATE_HOME;
afterEach(() => {
  if (previous === undefined) delete process.env.NOUGATE_HOME;
  else process.env.NOUGATE_HOME = previous;
});

describe('getDataDir', () => {
  test('an explicit NOUGATE_HOME wins: its data/ directory, whatever else exists', () => {
    process.env.NOUGATE_HOME = '/srv/host/.nouride';
    expect(getDataDir()).toBe(join('/srv/host/.nouride', 'data'));
    expect(dataPath('nougate.db')).toBe(join('/srv/host/.nouride', 'data', 'nougate.db'));
  });

  test('read on every call, so a host that sets it after import is still obeyed', () => {
    process.env.NOUGATE_HOME = '/one';
    expect(getDataDir()).toBe(join('/one', 'data'));
    process.env.NOUGATE_HOME = '/two';
    expect(getDataDir()).toBe(join('/two', 'data'));
  });

  test('standalone — no NOUGATE_HOME — is exactly what it was: /app/data in Docker, <root>/data otherwise', () => {
    delete process.env.NOUGATE_HOME;
    const expected = existsSync('/app/data') ? '/app/data' : join(getProjectRoot(), 'data');
    expect(getDataDir()).toBe(expected);
  });
});
