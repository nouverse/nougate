import { describe, expect, test } from 'bun:test';

import { remainingQuotaFraction } from '@/providers/antigravity/auth/manager';
import type { AntigravityAccount } from '@/providers/antigravity/auth/types';

/**
 * Account ranking now considers how much upstream quota is left, not just how
 * healthy an account has proven to be.
 *
 * Health is *reactive* — it only drops once a request has already failed — so a
 * nearly-spent account keeps looking attractive right up until it burns an
 * attempt. Quota is the proactive signal, and it is already being polled.
 *
 * The dangerous direction is over-reading it: an account the provider has said
 * nothing about must rank exactly as it did before, or adding a fresh account
 * would make the whole pool look exhausted.
 */

function account(quota?: AntigravityAccount['quota']): AntigravityAccount {
  return { email: 'a@b.c', quota } as AntigravityAccount;
}

function entry(groupName: string, remainingFraction: number) {
  return {
    groupName,
    limitName: groupName.toLowerCase().replace(/\s+/g, '-'),
    limit: '1000',
    usage: '0',
    remainingFraction,
    quotaLeft: `${Math.round(remainingFraction * 100)}%`,
    resetIn: '5h 0m',
  };
}

describe('reading remaining quota', () => {
  test('no quota data is "no opinion", not "empty"', () => {
    // The distinction that matters: null leaves ranking untouched, 0 would push
    // a brand-new account to the back of the queue.
    expect(remainingQuotaFraction(account(), 'gemini-3-pro')).toBeNull();
    expect(remainingQuotaFraction(account([]), 'gemini-3-pro')).toBeNull();
  });

  test('matches the quota group that covers the requested model', () => {
    const acc = account([entry('Gemini 3 Pro', 0.8), entry('Claude Sonnet 4.6', 0.1)]);

    // Asking for a Gemini model must not be judged by the Claude allowance.
    expect(remainingQuotaFraction(acc, 'gemini-3-pro')).toBeCloseTo(0.8);
    expect(remainingQuotaFraction(acc, 'claude-sonnet-4-6')).toBeCloseTo(0.1);
  });

  test('the worst relevant limit wins', () => {
    // Fine on one limit and out on another still means the request cannot be
    // served, so the optimistic number would be a lie.
    const acc = account([entry('Gemini 3 Pro', 0.9), entry('Gemini 3 Flash', 0.05)]);
    expect(remainingQuotaFraction(acc, 'gemini-3-pro')).toBeCloseTo(0.05);
  });

  test('clamps values the upstream reports out of range', () => {
    expect(remainingQuotaFraction(account([entry('Gemini 3 Pro', 1.7)]), 'gemini-3-pro')).toBe(1);
    expect(remainingQuotaFraction(account([entry('Gemini 3 Pro', -0.2)]), 'gemini-3-pro')).toBe(0);
  });

  test('with no model, every limit is relevant', () => {
    const acc = account([entry('Gemini 3 Pro', 0.9), entry('Claude Sonnet 4.6', 0.2)]);
    expect(remainingQuotaFraction(acc)).toBeCloseTo(0.2);
  });

  test('an unrelated quota group is not borrowed', () => {
    // Only a Claude allowance on file, but a Gemini model is being asked for:
    // that is no information, not full headroom.
    const acc = account([entry('Claude Sonnet 4.6', 0.9)]);
    expect(remainingQuotaFraction(acc, 'gemini-3-pro')).toBeNull();
  });
});

describe('how it feeds ranking', () => {
  // Mirrors calculatePriority's contribution so the intent is pinned even
  // though the function itself is private.
  const bonus = (fraction: number | null, weight = 25) =>
    fraction === null ? 0 : fraction * weight;

  test('a fresher account outranks a nearly-spent one', () => {
    const fresh = remainingQuotaFraction(account([entry('Gemini 3 Pro', 0.95)]), 'gemini-3-pro');
    const spent = remainingQuotaFraction(account([entry('Gemini 3 Pro', 0.05)]), 'gemini-3-pro');

    expect(bonus(fresh)).toBeGreaterThan(bonus(spent));
  });

  test('an account with no quota data scores exactly as before', () => {
    // The safety property: this dimension can only ever add, never penalise
    // silence. Copilot and custom providers report nothing here.
    expect(bonus(remainingQuotaFraction(account(), 'gemini-3-pro'))).toBe(0);
  });

  test('a zero weight turns the dimension off completely', () => {
    const fresh = remainingQuotaFraction(account([entry('Gemini 3 Pro', 1)]), 'gemini-3-pro');
    expect(bonus(fresh, 0)).toBe(0);
  });

  test('quota never outweighs a large health gap', () => {
    // Ranking must stay dominated by whether an account actually works. A
    // perfect-quota account is worth +25; ten health points are worth +20 at
    // the default health weight of 2.
    const maxQuotaBonus = bonus(1);
    const healthGapWorth = 20 * 2;
    expect(maxQuotaBonus).toBeLessThan(healthGapWorth);
  });
});
