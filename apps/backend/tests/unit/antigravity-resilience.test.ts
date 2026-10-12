import { describe, expect, test } from 'bun:test';

import { isModelUnsupportedFor } from '@/providers/antigravity/auth/manager';
import { nextAccountGapMs, summarizeExhaustion } from '@/providers/antigravity/upstream/executor';
import { parseQuotaResponse } from '@/providers/antigravity/api/quota';
import type { AntigravityAccount } from '@/providers/antigravity/auth/types';

/**
 * Three bugs that all shrank the usable account pool or lied about why a
 * request failed. Each test names the failure it prevents.
 */

const HOUR = 60 * 60 * 1000;

function account(overrides: Partial<AntigravityAccount> = {}): AntigravityAccount {
  return { email: 'a@b.c', ...overrides } as AntigravityAccount;
}

describe('a wrong "model unsupported" flag heals itself', () => {
  test('a fresh flag is honoured', () => {
    const acc = account({
      capabilities: { 'gemini-3-pro': false },
      capabilityFlaggedAt: { 'gemini-3-pro': Date.now() },
    });
    expect(isModelUnsupportedFor(acc, 'gemini-3-pro')).toBe(true);
  });

  test('a stale flag expires, so the account is probed again', () => {
    // Antigravity rolls models out per account. Today's 404 is often
    // tomorrow's supported model, and this flag used to be permanent — one
    // transient error removed an account from a model for good.
    const acc = account({
      capabilities: { 'gemini-3-pro': false },
      capabilityFlaggedAt: { 'gemini-3-pro': Date.now() - 7 * HOUR },
    });
    expect(isModelUnsupportedFor(acc, 'gemini-3-pro')).toBe(false);
  });

  test('a flag written before timestamps existed is not trusted forever', () => {
    // Accounts on disk from before this change carry the boolean and no
    // timestamp. Honouring those permanently would keep the original bug alive
    // for every existing deployment.
    const acc = account({ capabilities: { 'gemini-3-pro': false } });
    expect(isModelUnsupportedFor(acc, 'gemini-3-pro')).toBe(false);
  });

  test('it only ever blocks the model it was recorded against', () => {
    const acc = account({
      capabilities: { 'gemini-3-pro': false },
      capabilityFlaggedAt: { 'gemini-3-pro': Date.now() },
    });
    expect(isModelUnsupportedFor(acc, 'gemini-3-flash')).toBe(false);
    expect(isModelUnsupportedFor(acc, undefined)).toBe(false);
  });
});

describe('the client is told why every account failed', () => {
  const base = {
    model: 'antigravity:gemini-3-pro',
    attemptLogs: [],
    unsupportedCount: 0,
    systemicErrorCount: 0,
    lastStatus: 0,
    resetTime: null,
  };

  test('an upstream outage is a 503, not a quota error', () => {
    // The bug: three 5xx replies broke the retry loop and fell through to
    // "Quota Exhausted" — so clients backed off for a quota window over a
    // Google hiccup, and our own metrics recorded it as our quota running out.
    const result = summarizeExhaustion({
      ...base,
      attemptCount: 3,
      systemicErrorCount: 3,
      lastStatus: 503,
    });

    expect(result.status).toBe(503);
    expect(JSON.stringify(result.body)).toContain('upstream_unavailable');
    expect(JSON.stringify(result.body)).not.toContain('insufficient_quota');
  });

  test('a model no account carries is a 404', () => {
    const result = summarizeExhaustion({ ...base, attemptCount: 2, unsupportedCount: 2 });

    expect(result.status).toBe(404);
    expect(JSON.stringify(result.body)).toContain('model_not_found');
  });

  test('genuinely spent quota is still a 429', () => {
    const result = summarizeExhaustion({ ...base, attemptCount: 3, resetTime: '2h 14m' });

    expect(result.status).toBe(429);
    expect(JSON.stringify(result.body)).toContain('insufficient_quota');
    // The countdown is the one actionable thing in this case.
    expect(JSON.stringify(result.body)).toContain('2h 14m');
  });

  test('one account lacking the model does not make it a 404', () => {
    // Two accounts tried, only one lacked the model — the other failed for a
    // different reason, so "nobody has this model" would be false.
    const result = summarizeExhaustion({ ...base, attemptCount: 2, unsupportedCount: 1 });
    expect(result.status).toBe(429);
  });

  test('a stale 5xx count does not turn a quota failure into an outage', () => {
    // Recovered from the outage, then ran out of quota: lastStatus decides.
    const result = summarizeExhaustion({
      ...base,
      attemptCount: 4,
      systemicErrorCount: 1,
      lastStatus: 429,
    });
    expect(result.status).toBe(429);
  });
});

describe('quota groups report the figure conservatively', () => {
  test('the lower remaining fraction wins when models share a limit', () => {
    // Two models on one limitName share a bucket, so these should agree. When
    // they do not, keeping whichever was parsed first would over-report
    // headroom — and that number drives account ranking and the exhaustion
    // check, not just a dashboard card.
    const parsed = parseQuotaResponse({
      availableModels: {
        'models/gemini-3-pro': {
          displayMetadata: { label: 'Gemini 3 Pro' },
          quotaInfo: { limitName: 'shared-pool', remainingFraction: 0.9 },
        },
        'models/gemini-3-flash': {
          displayMetadata: { label: 'Gemini 3 Flash' },
          quotaInfo: { limitName: 'shared-pool', remainingFraction: 0.1 },
        },
      },
    });

    expect(parsed).toHaveLength(1);
    expect(parsed![0].remainingFraction).toBeCloseTo(0.1);
    expect(parsed![0].quotaLeft).toBe('10%');
  });

  test('separate limits stay separate', () => {
    const parsed = parseQuotaResponse({
      availableModels: {
        'models/gemini-3-pro': {
          displayMetadata: { label: 'Gemini 3 Pro' },
          quotaInfo: { limitName: 'pro-pool', remainingFraction: 0.9 },
        },
        'models/claude-opus-4-6': {
          displayMetadata: { label: 'Claude Opus 4.6' },
          quotaInfo: { limitName: 'claude-pool', remainingFraction: 0.1 },
        },
      },
    });

    expect(parsed).toHaveLength(2);
  });
});

describe('moving on to the next account', () => {
  test('pauses for a moment, never the seconds per attempt it used to', () => {
    // The old sleep grew by half a second per attempt up to three: thirteen attempts spent half a
    // minute asleep before a request was answered.
    for (let i = 0; i < 200; i += 1) {
      const gap = nextAccountGapMs();
      expect(gap).toBeGreaterThanOrEqual(150);
      expect(gap).toBeLessThan(450);
    }
  });
});
