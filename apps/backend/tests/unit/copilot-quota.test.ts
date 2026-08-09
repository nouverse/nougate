import { describe, expect, test } from 'bun:test';

import {
  formatResetIn,
  mapUserQuotas,
  mergeAccountQuotas,
} from '@/providers/copilot/auth/quota';

/**
 * These fixtures mirror a real `copilot_internal/user` response. The endpoint is
 * internal and undocumented, so the shapes here are the record of what it
 * actually returned — in particular that an unlimited plan reports every count
 * as zero, which naive `remaining / entitlement` arithmetic turns into NaN.
 */

/** A Copilot Business seat: unlimited everything, with consumption counted. */
const BUSINESS = {
  copilot_plan: 'business',
  quota_reset_date: '2026-09-01',
  quota_reset_date_utc: '2026-09-01T00:00:00.000Z',
  quota_snapshots: {
    chat: {
      unlimited: true,
      has_quota: true,
      percent_remaining: 100,
      entitlement: 0,
      remaining: 0,
      credits_used: 0,
      overage_permitted: false,
    },
    completions: {
      unlimited: true,
      has_quota: true,
      percent_remaining: 100,
      entitlement: 0,
      remaining: 0,
      credits_used: 0,
      overage_permitted: false,
    },
    premium_interactions: {
      unlimited: true,
      has_quota: true,
      percent_remaining: 100,
      entitlement: 0,
      remaining: 0,
      credits_used: 1493,
      overage_permitted: true,
    },
  },
};

/** A capped plan, where the entitlement figures carry real information. */
const CAPPED = {
  copilot_plan: 'individual',
  quota_reset_date_utc: '2026-09-01T00:00:00.000Z',
  quota_snapshots: {
    premium_interactions: {
      unlimited: false,
      has_quota: true,
      percent_remaining: 25,
      entitlement: 300,
      remaining: 75,
      credits_used: 225,
    },
  },
};

describe('copilot quota mapping', () => {
  test('an unlimited plan is reported as unlimited, not as 0/0', () => {
    const quotas = mapUserQuotas(BUSINESS as any);
    const premium = quotas.find((quota) => quota.id === 'premium_interactions')!;

    expect(premium.unlimited).toBe(true);
    // The bug this guards: entitlement and remaining are both 0 on this plan,
    // so dividing them gives NaN and the card renders an empty bar.
    expect(Number.isNaN(premium.remainingFraction)).toBe(false);
    expect(premium.remainingFraction).toBe(1);
    // With no cap, the meaningful figure is what has been spent.
    expect(premium.used).toBe('1493');
    expect(premium.limit).toBeUndefined();
  });

  test('a capped plan reports headroom and what it was measured against', () => {
    const [premium] = mapUserQuotas(CAPPED as any);

    expect(premium.unlimited).toBe(false);
    expect(premium.remainingFraction).toBeCloseTo(0.25);
    expect(premium.used).toBe('225'); // entitlement - remaining
    expect(premium.limit).toBe('300');
  });

  test('every entitlement GitHub reports becomes its own card', () => {
    const quotas = mapUserQuotas(BUSINESS as any);

    expect(quotas.map((quota) => quota.id).sort()).toEqual([
      'chat',
      'completions',
      'premium_interactions',
    ]);
    expect(quotas.map((quota) => quota.label)).toContain('Premium requests');
  });

  test('an entitlement the plan does not include is left out', () => {
    const quotas = mapUserQuotas({
      quota_snapshots: { chat: { has_quota: false, unlimited: false } },
    } as any);

    expect(quotas).toEqual([]);
  });

  test('an unknown future entitlement still gets a readable label', () => {
    // GitHub has added entitlements before and will again; an unmapped key must
    // not render as a raw snake_case string.
    const [quota] = mapUserQuotas({
      quota_snapshots: { agent_sessions: { unlimited: true, has_quota: true } },
    } as any);

    expect(quota.id).toBe('agent_sessions');
    expect(quota.label).toBe('Agent sessions');
  });

  test('missing quota data yields nothing rather than throwing', () => {
    expect(mapUserQuotas({} as any)).toEqual([]);
  });
});

describe('reset countdown', () => {
  const now = Date.parse('2026-08-09T00:00:00.000Z');

  test('leads with days on a monthly cycle', () => {
    expect(formatResetIn('2026-09-01T00:00:00.000Z', now)).toBe('23d 0h');
  });

  test('falls back to hours and minutes inside a day', () => {
    expect(formatResetIn('2026-08-09T04:30:00.000Z', now)).toBe('4h 30m');
  });

  test('never counts backwards once the window has passed', () => {
    expect(formatResetIn('2026-08-01T00:00:00.000Z', now)).toBe('0m');
  });

  test('ignores a date it cannot parse', () => {
    expect(formatResetIn('not a date', now)).toBeUndefined();
    expect(formatResetIn(undefined, now)).toBeUndefined();
  });
});

describe('merging seats', () => {
  test('a single account passes through with its limit intact', () => {
    const [premium] = mergeAccountQuotas([mapUserQuotas(CAPPED as any)]);

    expect(premium.remainingFraction).toBeCloseTo(0.25);
    expect(premium.limit).toBe('300');
  });

  test('averages headroom and sums usage across seats', () => {
    const other = {
      ...CAPPED,
      quota_snapshots: {
        premium_interactions: {
          unlimited: false,
          has_quota: true,
          percent_remaining: 75,
          entitlement: 300,
          remaining: 225,
        },
      },
    };

    const [premium] = mergeAccountQuotas([
      mapUserQuotas(CAPPED as any),
      mapUserQuotas(other as any),
    ]);

    // Rotation across two seats at 25% and 75% finds 50% headroom...
    expect(premium.remainingFraction).toBeCloseTo(0.5);
    // ...and the pool has burned 225 + 75 between them.
    expect(premium.used).toBe('300');
    // A summed usage against one seat's entitlement is not a ratio, so no limit
    // is claimed rather than printing a misleading "300 / 300".
    expect(premium.limit).toBeUndefined();
  });

  test('one capped seat makes the pool capped', () => {
    const [premium] = mergeAccountQuotas([
      mapUserQuotas(BUSINESS as any).filter((q) => q.id === 'premium_interactions'),
      mapUserQuotas(CAPPED as any),
    ]);

    // Claiming "unlimited" while a seat can run dry would hide a real failure.
    expect(premium.unlimited).toBe(false);
    expect(premium.remainingFraction).toBeCloseTo(0.625);
  });

  test('no reachable account means no quotas, not a crash', () => {
    expect(mergeAccountQuotas([])).toEqual([]);
  });
});
