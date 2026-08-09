import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Selection must walk past an account it cannot make ready.
 *
 * The bug this pins down: `ensureAccountReady` returns null when a refresh
 * token will not refresh, and selection used to return that null straight to
 * the caller. The executor never recorded the account as tried, so the next
 * attempt ranked it first again — one dead token could burn every retry, each
 * costing a token round trip and a backoff sleep, while healthy accounts idled.
 *
 * Driving the real refresh path needs live Google credentials, so this asserts
 * the control flow that carries the fix. Structural on purpose: a test that
 * instantiated nothing but looked like behaviour coverage would be worse than
 * an honest limit.
 */

const source = readFileSync(
  join(import.meta.dir, '../../src/providers/antigravity/auth/manager.ts'),
  'utf8',
);

describe('account selection survives an account that will not refresh', () => {
  test('the ranked list is walked, not indexed once', () => {
    expect(source).toContain('for (let step = 0; step < candidates.length; step += 1)');
    expect(source).not.toContain('return await ensureAccountReady(candidates[selectedIndex]);');
  });

  test('no call site returns an unchecked readiness result', () => {
    // A bare `return await ensureAccountReady(...)` is the failure mode: it
    // hands a null straight back and ends selection.
    const bareReturns = source.match(/return await ensureAccountReady\(/g) ?? [];
    expect(bareReturns).toHaveLength(0);
  });

  test('a failure to ready an account is visible to the operator', () => {
    // Skipping silently would hide a dead credential until someone noticed the
    // pool had quietly shrunk.
    expect(source).toContain('could not be made ready');
  });

  test('selection still gives up once nothing is left', () => {
    const loopBody = source.slice(source.indexOf('for (let step = 0'));
    expect(loopBody).toContain('return null;');
  });

  test('the sticky paths fall through instead of failing the request', () => {
    // Cache-first and client-sticky both prefer one account; neither may fail
    // the whole request when that account cannot be readied.
    expect(source).toContain('const ready = await ensureAccountReady(stickyAccount);');
    expect(source).toContain('const ready = await ensureAccountReady(sticky);');
  });
});
