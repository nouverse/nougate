import { afterEach, describe, expect, test } from 'bun:test';

import {
  AccountLimitError,
  assertAccountSlotAvailable,
  capRotationPool,
  getMaxAccountMultiplexing,
} from '@/core/rotation-pool';

/**
 * The cap decides how many accounts an upstream sees rotating behind one egress
 * IP. Two properties have to hold: an unset variable changes nothing at all, and
 * a set one never reorders the ranking it is trimming.
 */

afterEach(() => {
  delete process.env.MAX_ACCOUNT_MULTIPLEXING;
});

const RANKED = ['a', 'b', 'c', 'd', 'e', 'f'];

describe('getMaxAccountMultiplexing', () => {
  test('is null when unset or blank, which means uncapped', () => {
    delete process.env.MAX_ACCOUNT_MULTIPLEXING;
    expect(getMaxAccountMultiplexing()).toBeNull();

    process.env.MAX_ACCOUNT_MULTIPLEXING = '  ';
    expect(getMaxAccountMultiplexing()).toBeNull();
  });

  test('ignores values that could not bound a pool', () => {
    for (const bad of ['0', '-3', '2.5', 'five']) {
      process.env.MAX_ACCOUNT_MULTIPLEXING = bad;
      expect(getMaxAccountMultiplexing()).toBeNull();
    }
  });
});

describe('capRotationPool', () => {
  test('returns the whole pool when nothing is configured', () => {
    delete process.env.MAX_ACCOUNT_MULTIPLEXING;
    expect(capRotationPool(RANKED)).toEqual(RANKED);
  });

  test('keeps the top N of an already-ranked list, in order', () => {
    process.env.MAX_ACCOUNT_MULTIPLEXING = '3';
    expect(capRotationPool(RANKED)).toEqual(['a', 'b', 'c']);
  });

  test('a cap wider than the pool is a no-op', () => {
    process.env.MAX_ACCOUNT_MULTIPLEXING = '50';
    expect(capRotationPool(RANKED)).toEqual(RANKED);
  });

  test('does not mutate the list it was given', () => {
    process.env.MAX_ACCOUNT_MULTIPLEXING = '2';
    const input = [...RANKED];
    capRotationPool(input);
    expect(input).toEqual(RANKED);
  });
});

describe('assertAccountSlotAvailable', () => {
  test('allows anything when no limit is configured', () => {
    delete process.env.MAX_ACCOUNT_MULTIPLEXING;
    expect(() => assertAccountSlotAvailable('account', 99)).not.toThrow();
  });

  test('allows the add that fills the last slot', () => {
    process.env.MAX_ACCOUNT_MULTIPLEXING = '5';
    expect(() => assertAccountSlotAvailable('account', 4)).not.toThrow();
  });

  test('refuses the add that would exceed the limit', () => {
    process.env.MAX_ACCOUNT_MULTIPLEXING = '5';
    expect(() => assertAccountSlotAvailable('Copilot account', 5)).toThrow(AccountLimitError);
  });

  test('refuses when already over the limit, e.g. after the cap was lowered', () => {
    process.env.MAX_ACCOUNT_MULTIPLEXING = '3';
    expect(() => assertAccountSlotAvailable('account', 8)).toThrow(AccountLimitError);
  });

  test('the refusal carries a 409 and names the limit', () => {
    process.env.MAX_ACCOUNT_MULTIPLEXING = '2';

    try {
      assertAccountSlotAvailable('API key for "deepseek"', 2);
      throw new Error('expected assertAccountSlotAvailable to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AccountLimitError);
      expect((error as AccountLimitError).status).toBe(409);
      expect((error as AccountLimitError).limit).toBe(2);
      expect((error as AccountLimitError).message).toContain('MAX_ACCOUNT_MULTIPLEXING is 2');
      expect((error as AccountLimitError).message).toContain('deepseek');
    }
  });
});
