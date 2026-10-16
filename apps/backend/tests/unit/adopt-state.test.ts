/**
 * `adoptStateFrom` — a host that moved where it points `NOUGATE_HOME` gets the gateway's state
 * brought along, once, copied by name, and never over a database already in use.
 *
 * Nouride did exactly that: the gateway's state used to sit in Nouride's own `data/` (binary installs)
 * or in `/app/data` (its Docker images), and now has a folder of its own.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { adoptStateFrom, forgetStateIn } from '../../src/boot';

let dir: string;
let hostData: string;
let oldImage: string;
let target: string;
const previous = process.env.NOUGATE_HOME;

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

function stateIn(where: string, marker: string) {
  write(join(where, 'nougate.db'), marker);
  write(join(where, 'nougate.db-wal'), `${marker}-wal`);
  write(join(where, 'config.json'), '{}');
  write(join(where, 'providers', 'claudecode', 'accounts.json'), 'accounts');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nougate-adopt-'));
  hostData = join(dir, '.nouride', 'data');
  oldImage = join(dir, 'app-data');
  process.env.NOUGATE_HOME = join(dir, '.nouride', 'nougate');
  target = join(dir, '.nouride', 'nougate', 'data');
  write(join(hostData, 'nouride.db'), "the host's own");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (previous === undefined) delete process.env.NOUGATE_HOME;
  else process.env.NOUGATE_HOME = previous;
});

describe('adoptStateFrom', () => {
  test("copies by name out of the host's data directory — database, WAL, providers — and nothing of the host's", () => {
    stateIn(hostData, 'host');
    expect(adoptStateFrom([hostData, oldImage])).toBe(hostData);
    expect(read(join(target, 'nougate.db'))).toBe('host');
    // The WAL travels with its database, or the last writes before the move are lost.
    expect(read(join(target, 'nougate.db-wal'))).toBe('host-wal');
    expect(read(join(target, 'providers', 'claudecode', 'accounts.json'))).toBe('accounts');
    expect(existsSync(join(target, 'nouride.db'))).toBe(false);
  });

  test("leaves the source untouched, so the host's previous build still finds it after a rollback", () => {
    stateIn(hostData, 'host');
    adoptStateFrom([hostData]);
    expect(read(join(hostData, 'nougate.db'))).toBe('host');
    expect(read(join(hostData, 'nougate.db-wal'))).toBe('host-wal');
    expect(read(join(hostData, 'providers', 'claudecode', 'accounts.json'))).toBe('accounts');
  });

  test('the first source with a database wins', () => {
    stateIn(hostData, 'host');
    stateIn(oldImage, 'old-image');
    adoptStateFrom([hostData, oldImage]);
    expect(read(join(target, 'nougate.db'))).toBe('host');
  });

  test('never over a database already there, and so only once', () => {
    write(join(target, 'nougate.db'), 'current');
    stateIn(hostData, 'host');
    expect(adoptStateFrom([hostData])).toBeNull();
    expect(read(join(target, 'nougate.db'))).toBe('current');
    expect(existsSync(join(target, 'config.json'))).toBe(false);
  });

  test('nothing to adopt, nothing done', () => {
    expect(adoptStateFrom([hostData, oldImage])).toBeNull();
    expect(existsSync(target)).toBe(false);
  });
});

describe('forgetStateIn', () => {
  test("deletes the old copy by name once the gateway's own folder has the state — and none of the host's files", () => {
    stateIn(hostData, 'host');
    adoptStateFrom([hostData, oldImage]);
    const removed = forgetStateIn([hostData, oldImage]);
    expect(removed.map((path) => path.slice(hostData.length + 1)).sort()).toEqual(['config.json', 'nougate.db', 'nougate.db-wal', 'providers']);
    expect(existsSync(join(hostData, 'nougate.db'))).toBe(false);
    expect(existsSync(join(hostData, 'providers'))).toBe(false);
    // The host's own database, beside them, stays.
    expect(read(join(hostData, 'nouride.db'))).toBe("the host's own");
    // And the gateway's own copy is untouched.
    expect(read(join(target, 'nougate.db'))).toBe('host');
  });

  test('deletes nothing while the gateway has no state of its own — the old copy is all there is', () => {
    stateIn(hostData, 'host');
    expect(forgetStateIn([hostData])).toEqual([]);
    expect(read(join(hostData, 'nougate.db'))).toBe('host');
  });

  test("never deletes from the gateway's own data directory, even when named as a source", () => {
    stateIn(hostData, 'host');
    adoptStateFrom([hostData]);
    forgetStateIn([target, hostData]);
    expect(read(join(target, 'nougate.db'))).toBe('host');
  });
});

