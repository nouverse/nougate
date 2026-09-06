/**
 * Which credential answers next, and what a failure does to it.
 *
 * The three states — healthy, cooling, invalid — have to stay distinct. Collapsing them is how a
 * gateway either retires a working subscription over one rate limit, or keeps offering a dead
 * credential forever and reports the whole provider as broken.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as manager from '@/providers/claudecode/auth/manager';

let dir: string;

/**
 * A fresh accounts file, and a manager reloaded from it.
 *
 * The manager keeps accounts in module state, so `initManager` has to *replace* rather than append
 * for this to work — which it does, and which is asserted by every test here passing in sequence.
 * Storage resolves its path per call, so pointing the env var at a new directory is enough.
 */
async function freshManager() {
  dir = mkdtempSync(join(tmpdir(), 'claude-code-'));
  process.env.CLAUDE_CODE_ACCOUNTS_FILE = join(dir, 'accounts.json');
  await manager.initManager();
  return manager;
}

beforeEach(() => {
  dir = '';
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  delete process.env.CLAUDE_CODE_ACCOUNTS_FILE;
});

describe('adding credentials', () => {
  test('the same credential twice is one account, not two', async () => {
    // Two entries for one credential would double its share of the rotation and halve everyone
    // else's — silently, and in a way that looks like a scheduling bug.
    const m = await freshManager();
    const first = await m.addAccount('sk-ant-api03-same');
    const second = await m.addAccount('sk-ant-api03-same');

    expect(second.id).toBe(first.id);
    expect(m.getAccounts()).toHaveLength(1);
  });

  test('a label falls back to a fingerprint, never to the credential', async () => {
    const m = await freshManager();
    const account = await m.addAccount('sk-ant-api03-secretmiddle-xyz9');

    expect(account.label).not.toContain('secretmiddle');
    expect(account.label).toContain('…');
  });

  test('an empty credential is refused rather than stored', async () => {
    const m = await freshManager();
    expect(m.addAccount('   ')).rejects.toThrow('a credential is required');
  });
});

describe('choosing one', () => {
  test('nothing to choose from is null, not a throw', async () => {
    // The executor turns this into an operator-readable message; an exception here would be a stack
    // trace in a chat client instead.
    const m = await freshManager();
    expect(await m.getBestAccount('claude-opus-5')).toBeNull();
  });

  test('a credential already tried this request is not offered again', async () => {
    // Otherwise a retry burns every attempt on the same failing credential.
    const m = await freshManager();
    const a = await m.addAccount('token-a');
    const b = await m.addAccount('token-b');

    const picked = await m.getBestAccount('claude-opus-5', [a.id]);
    expect(picked?.id).toBe(b.id);
  });

  test('a cooling credential is skipped, then offered again once it passes', async () => {
    const m = await freshManager();
    const a = await m.addAccount('token-a');
    const b = await m.addAccount('token-b');

    await m.markCooldown(a.id, m.cooldownScope('claude-opus-5'), 60_000);
    const during = await m.getBestAccount('claude-opus-5', []);
    expect(during?.id).not.toBe(a.id);

    // Cooldowns are per scope: a limit on one model is not a limit on another.
    const other = await m.getBestAccount('claude-sonnet-5', []);
    expect(other).not.toBeNull();

    // Excluding the other credential is what makes this assert the cooldown lifted, rather than
    // asserting that *some* account was available — which was true while `a` was still benched.
    await m.resetAccount(a.id);
    const after = await m.getBestAccount('claude-opus-5', [b.id]);
    expect(after?.id).toBe(a.id);
  });

  test('an invalidated credential is never offered but is still listed', async () => {
    /**
     * Both halves matter. Never offered, because a dead credential burns an attempt every request.
     * Still listed, because an operator who cannot see it cannot tell "my token expired" from "I
     * pasted it wrong" — and those have different fixes.
     */
    const m = await freshManager();
    const a = await m.addAccount('token-a');
    await m.invalidate(a.id, 'the API key was rejected');

    expect(await m.getBestAccount('claude-opus-5')).toBeNull();
    expect(m.getAccounts()).toHaveLength(1);
    expect(m.getAccounts()[0]!.invalidReason).toBe('the API key was rejected');
  });

  test('replacing the credential brings the account back', async () => {
    // And clears the cooldown with it: a replaced credential is a new credential, and carrying the
    // old one's cooldown would leave a working key idle with nothing on screen explaining why.
    const m = await freshManager();
    const a = await m.addAccount('old-token');
    await m.markCooldown(a.id, m.cooldownScope('claude-opus-5'), 60_000);
    await m.invalidate(a.id, 'expired');

    await m.replaceCredential(a.id, 'new-token');

    const picked = await m.getBestAccount('claude-opus-5');
    expect(picked?.id).toBe(a.id);
    expect(picked?.credential).toBe('new-token');
    expect(picked?.invalidatedAt).toBeUndefined();
  });
});

describe('what a result does to the score', () => {
  test('failure drops it faster than success recovers it', async () => {
    // One lucky call after a run of failures is not evidence the credential is well. A score that
    // snapped back to 100 would hide a flapping account entirely.
    const m = await freshManager();
    const a = await m.addAccount('token-a');

    await m.updateAccountUsage(a.id, false);
    const afterFailure = m.getAccounts()[0]!.healthScore;
    await m.updateAccountUsage(a.id, true);
    const afterSuccess = m.getAccounts()[0]!.healthScore;

    expect(afterFailure).toBeCloseTo(80, 5);
    expect(afterSuccess - afterFailure).toBeLessThan(100 - afterFailure);
    expect(m.getAccounts()[0]!.consecutiveFailures).toBe(0);
  });

  test('the score never leaves 0–100 however many failures land', async () => {
    const m = await freshManager();
    const a = await m.addAccount('token-a');
    for (let i = 0; i < 20; i++) await m.updateAccountUsage(a.id, false);

    expect(m.getAccounts()[0]!.healthScore).toBe(0);
  });
});

describe('rate-limit headers', () => {
  test('what Anthropic reported is remembered', async () => {
    const m = await freshManager();
    const a = await m.addAccount('token-a');

    await m.recordRateLimit(
      a.id,
      new Headers({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-remaining': '42',
        'anthropic-ratelimit-unified-limit': '100',
        'anthropic-ratelimit-unified-reset': '2026-09-06T12:00:00Z',
      }),
    );

    const limit = m.getAccounts()[0]!.rateLimit!;
    expect(limit.status).toBe('allowed');
    expect(limit.remaining).toBe(42);
    expect(limit.resetsAt).toBe(Date.parse('2026-09-06T12:00:00Z'));
  });

  test('headers that said nothing record nothing', async () => {
    // Writing zeroes would draw an empty quota bar for a plan that never claimed to have a limit.
    const m = await freshManager();
    const a = await m.addAccount('token-a');
    await m.recordRateLimit(a.id, new Headers({ 'content-type': 'application/json' }));

    expect(m.getAccounts()[0]!.rateLimit).toBeUndefined();
  });
});
