import { afterEach, describe, expect, test } from 'bun:test';

import {
  DEFAULT_JITTER_CONFIG,
  applyJitter,
  getBottomJitterMs,
  normalizeJitterConfig,
  resolveJitterWindow,
} from '@/core/jitter';

/**
 * `BOTTOM_JITTER` is the one control an operator has over every provider at
 * once. The tests that matter are the ones where a provider's own config
 * disagrees with it: a floor that only applies when a provider happens to agree
 * is not a floor.
 */

const ENV_KEYS = ['BOTTOM_JITTER', 'BOTTOM_JITTER_MS'] as const;

function setFloor(value: string | undefined, key: (typeof ENV_KEYS)[number] = 'BOTTOM_JITTER') {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

describe('normalizeJitterConfig', () => {
  test('fills every field from the shared default', () => {
    expect(normalizeJitterConfig(undefined)).toEqual(DEFAULT_JITTER_CONFIG);
    expect(normalizeJitterConfig({})).toEqual(DEFAULT_JITTER_CONFIG);
  });

  test('raises a maximum that sits below the minimum', () => {
    expect(normalizeJitterConfig({ jitterMinMs: 4000, jitterMaxMs: 1000 })).toEqual({
      jitterEnabled: true,
      jitterMinMs: 4000,
      jitterMaxMs: 4000,
    });
  });

  test('clamps a negative minimum to zero', () => {
    expect(normalizeJitterConfig({ jitterMinMs: -500 }).jitterMinMs).toBe(0);
  });
});

describe('getBottomJitterMs', () => {
  test('is null when unset or blank, which means no clamping at all', () => {
    setFloor(undefined);
    expect(getBottomJitterMs()).toBeNull();

    setFloor('   ');
    expect(getBottomJitterMs()).toBeNull();
  });

  test('reads the BOTTOM_JITTER_MS spelling too', () => {
    setFloor('2500', 'BOTTOM_JITTER_MS');
    expect(getBottomJitterMs()).toBe(2500);
  });

  test('ignores values that are not a non-negative number', () => {
    setFloor('abc');
    expect(getBottomJitterMs()).toBeNull();

    setFloor('-1');
    expect(getBottomJitterMs()).toBeNull();
  });
});

describe('resolveJitterWindow', () => {
  test('leaves the provider window alone when no floor is set', () => {
    setFloor(undefined);
    expect(resolveJitterWindow({ jitterEnabled: true, jitterMinMs: 1000, jitterMaxMs: 3000 })).toEqual({
      minMs: 1000,
      maxMs: 3000,
    });
  });

  test('a provider may opt out entirely when no floor is set', () => {
    setFloor(undefined);
    expect(resolveJitterWindow({ jitterEnabled: false, jitterMinMs: 1000, jitterMaxMs: 3000 })).toBeNull();
  });

  test('raises a window that sits below the floor', () => {
    setFloor('3000');
    expect(resolveJitterWindow({ jitterEnabled: true, jitterMinMs: 1000, jitterMaxMs: 3000 })).toEqual({
      minMs: 3000,
      maxMs: 3000,
    });
  });

  test('drags the maximum up with the minimum', () => {
    setFloor('4000');
    expect(resolveJitterWindow({ jitterEnabled: true, jitterMinMs: 1000, jitterMaxMs: 2000 })).toEqual({
      minMs: 4000,
      maxMs: 4000,
    });
  });

  test('leaves a window that already clears the floor untouched', () => {
    setFloor('500');
    expect(resolveJitterWindow({ jitterEnabled: true, jitterMinMs: 2000, jitterMaxMs: 5000 })).toEqual({
      minMs: 2000,
      maxMs: 5000,
    });
  });

  test('overrides a provider that switched jitter off', () => {
    // The whole point of the floor: a provider config cannot buy its way out of
    // a minimum the operator set for the pod.
    setFloor('3000');
    expect(resolveJitterWindow({ jitterEnabled: false, jitterMinMs: 0, jitterMaxMs: 0 })).toEqual({
      minMs: 3000,
      maxMs: 3000,
    });
  });

  test('BOTTOM_JITTER=0 is a floor of zero, not a demand to delay', () => {
    setFloor('0');
    expect(resolveJitterWindow({ jitterEnabled: false, jitterMinMs: 0, jitterMaxMs: 0 })).toBeNull();
    expect(resolveJitterWindow({ jitterEnabled: true, jitterMinMs: 10, jitterMaxMs: 20 })).toEqual({
      minMs: 10,
      maxMs: 20,
    });
  });
});

describe('applyJitter', () => {
  test('waits at least the floor even when the provider asked for nothing', async () => {
    setFloor('60');
    const started = Date.now();
    const waited = await applyJitter({ jitterEnabled: false, jitterMinMs: 0, jitterMaxMs: 0 });

    expect(waited).toBeGreaterThanOrEqual(60);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });

  test('does not wait when jitter is off and no floor is set', async () => {
    setFloor(undefined);
    expect(await applyJitter({ jitterEnabled: false, jitterMinMs: 1000, jitterMaxMs: 3000 })).toBe(0);
  });

  test('stays inside the resolved window', async () => {
    setFloor(undefined);
    const waited = await applyJitter({ jitterEnabled: true, jitterMinMs: 10, jitterMaxMs: 30 });
    expect(waited).toBeGreaterThanOrEqual(10);
    expect(waited).toBeLessThanOrEqual(30);
  });
});
