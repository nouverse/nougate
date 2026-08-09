import { describe, expect, test } from 'bun:test';

import type { IProvider, IProviderQuota } from '@/core/interfaces';
import { mergeAccountQuotas } from '@/providers/antigravity';
import type { AntigravityAccount } from '@/providers/antigravity/auth/types';

/**
 * Quota is a provider *capability*, not an Antigravity feature that the rest of
 * the app knows about by name.
 *
 * Every provider counts usage differently — a rolling window, a monthly seat
 * allowance, prepaid credits — so `getQuotas()` is the seam: a provider does
 * whatever it must and returns the normalised shape. Nothing downstream may
 * branch on a provider id. These tests exist to keep that true.
 */

function account(quota: NonNullable<AntigravityAccount['quota']>): AntigravityAccount {
  return { quota } as AntigravityAccount;
}

function entry(overrides: Partial<NonNullable<AntigravityAccount['quota']>[number]>) {
  return {
    groupName: 'Gemini 3 Pro',
    limitName: 'gemini-3-pro',
    limit: '1000',
    usage: '0',
    remainingFraction: 1,
    quotaLeft: '100%',
    resetIn: '5h 0m',
    ...overrides,
  };
}

describe('quota is a capability, not a provider name', () => {
  test('the router detects support from the method, not the id', () => {
    // This mirrors exactly what /api/providers/:id does. If someone replaces it
    // with an id check, this test still passes but the next one fails.
    const supportsQuota = (provider: Partial<IProvider>) => typeof provider.getQuotas === 'function';

    expect(supportsQuota({ id: 'antigravity', getQuotas: async () => [] })).toBe(true);
    expect(supportsQuota({ id: 'copilot' })).toBe(false);
  });

  test('a brand-new provider gains quota support without any core change', async () => {
    // A hypothetical credit-based provider: nothing like Antigravity's model
    // families, and it never appears in a list of "providers with quotas".
    const invented: Pick<IProvider, 'id' | 'getQuotas'> = {
      id: 'some-future-provider',
      getQuotas: async (): Promise<IProviderQuota[]> => [
        {
          id: 'credits',
          label: 'Prepaid credits',
          remainingFraction: 0.42,
          used: '$58.00',
          limit: '$100.00',
          resetIn: 'never',
        },
      ],
    };

    const quotas = await invented.getQuotas!();
    expect(quotas).toHaveLength(1);
    expect(quotas[0].remainingFraction).toBeCloseTo(0.42);
    // The dashboard renders these fields and nothing else.
    expect(quotas[0]).toHaveProperty('label');
    expect(quotas[0]).toHaveProperty('id');
  });
});

describe('account flow is declared, not inferred', () => {
  test('each provider states how the dashboard should add an account', async () => {
    const { AntigravityProvider } = await import('@/providers/antigravity');
    const { CopilotProvider } = await import('@/providers/copilot');
    const { CustomProvider } = await import('@/providers/custom');

    // The dashboard used to pick its add-account form with
    // `id === 'copilot' ? device : googleOAuth`, so every custom provider was
    // offered a Google sign-in dialog it could not use.
    //
    // Constructed, not read off the prototype: these are class fields, so they
    // only exist on an instance.
    expect(new AntigravityProvider().accountFlow).toBe('oauth-redirect');
    expect(new CopilotProvider().accountFlow).toBe('device-code');
    expect(new CustomProvider({ id: 'x', baseUrl: 'https://x.dev/v1' } as never).accountFlow).toBe(
      'api-key',
    );
  });
});

describe('antigravity quota merging', () => {
  test('averages one limit across accounts, so the pool figure is honest', () => {
    const [quota] = mergeAccountQuotas([
      account([entry({ remainingFraction: 1 })]),
      account([entry({ remainingFraction: 0.5 })]),
      account([entry({ remainingFraction: 0 })]),
    ]);

    expect(quota.remainingFraction).toBeCloseTo(0.5);
  });

  test('describes the account nearest to running out', () => {
    const [quota] = mergeAccountQuotas([
      account([entry({ remainingFraction: 1, usage: '0', resetIn: '5h 0m' })]),
      account([entry({ remainingFraction: 0.1, usage: '900', resetIn: '20m' })]),
    ]);

    // Averaging the fraction but keeping a healthy account's text would read as
    // "half full, resets in 5h" while a key is about to start failing.
    expect(quota.used).toBe('900');
    expect(quota.resetIn).toBe('20m');
  });

  test('keeps distinct limits apart', () => {
    const quotas = mergeAccountQuotas([
      account([
        entry({ limitName: 'pro', groupName: 'Pro' }),
        entry({ limitName: 'flash', groupName: 'Flash', remainingFraction: 0.2 }),
      ]),
    ]);

    expect(quotas.map((quota) => quota.id).sort()).toEqual(['flash', 'pro']);
  });

  test('accounts with no quota yet contribute nothing rather than a zero', () => {
    // An unverified account has no figures. Counting it as 0% would make a
    // healthy provider look exhausted the moment someone adds a new account.
    const [quota] = mergeAccountQuotas([
      account([entry({ remainingFraction: 1 })]),
      { } as AntigravityAccount,
      account([]),
    ]);

    expect(quota.remainingFraction).toBeCloseTo(1);
  });

  test('reports nothing at all when no account has answered', () => {
    expect(mergeAccountQuotas([{ } as AntigravityAccount])).toEqual([]);
  });
});
