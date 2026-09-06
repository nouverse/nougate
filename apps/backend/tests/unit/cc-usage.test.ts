/**
 * Reading the plan's own limit windows, and not hammering the endpoint that reports them.
 *
 * The quota panel used to be derived from response headers, which on a consumer subscription say
 * almost nothing — so a plan with a very real five-hour cap was reported as `unlimited`. This is the
 * direct reading, and every test here is about a way the direct reading goes wrong: an inverted
 * percentage, an invented row, or a poll loop that turns a soft rate limit into a hard one.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getUsage, resetUsageCache } from '@/providers/cc/api/usage';

const realFetch = globalThis.fetch;

beforeEach(() => {
  resetUsageCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetUsageCache();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** An OAuth access token, which is anything without the documented API-key prefix. */
const OAUTH_TOKEN = 'sk-ant-oat01-abcdef';

describe('reading the windows', () => {
  test('utilization is a percentage USED, and comes back as headroom', async () => {
    // The inversion that matters: reading 87 as "87% left" draws a nearly-full bar on an account
    // with minutes remaining, which is the single most misleading thing this panel could do.
    globalThis.fetch = (async () =>
      json({ five_hour: { utilization: 87, resets_at: '2026-09-06T12:00:00Z' } })) as unknown as typeof fetch;

    const usage = await getUsage(OAUTH_TOKEN);
    const session = usage!.windows.find((w) => w.label === 'session (5h)')!;

    expect(session.utilizationPercent).toBe(87);
    expect(session.remainingFraction).toBeCloseTo(0.13, 5);
    expect(session.resetsAt).toBe(Date.parse('2026-09-06T12:00:00Z'));
  });

  test('per-model weekly windows are reported separately', async () => {
    // Opus exhausted while Sonnet is untouched is the normal case, and one merged figure hides it.
    globalThis.fetch = (async () =>
      json({
        seven_day: { utilization: 40 },
        seven_day_opus: { utilization: 95 },
        seven_day_sonnet: { utilization: 10 },
      })) as unknown as typeof fetch;

    const labels = (await getUsage(OAUTH_TOKEN))!.windows.map((w) => w.label);
    expect(labels).toContain('weekly (7d)');
    expect(labels).toContain('weekly opus (7d)');
    expect(labels).toContain('weekly sonnet (7d)');
  });

  test('a model key that needs renaming gets its operator-facing name', async () => {
    globalThis.fetch = (async () => json({ seven_day_fable_5_1: { utilization: 20 } })) as unknown as typeof fetch;
    expect((await getUsage(OAUTH_TOKEN))!.windows[0]!.label).toBe('weekly fable (7d)');
  });

  test('a model nobody has taught this file about still shows up', async () => {
    // Read by prefix rather than from a fixed list, so an upstream addition appears without a code
    // change instead of being silently dropped.
    globalThis.fetch = (async () => json({ seven_day_newmodel: { utilization: 5 } })) as unknown as typeof fetch;
    expect((await getUsage(OAUTH_TOKEN))!.windows[0]!.label).toBe('weekly newmodel (7d)');
  });

  test('a window the server did not report produces no row at all', async () => {
    // Never defaulted to zero. "0% used" on a window nobody reported is the most reassuring possible
    // way to be wrong, and an operator would act on it.
    globalThis.fetch = (async () => json({ five_hour: { utilization: 50 } })) as unknown as typeof fetch;

    const labels = (await getUsage(OAUTH_TOKEN))!.windows.map((w) => w.label);
    expect(labels).toEqual(['session (5h)']);
  });

  test('a window carrying no utilization number is not a window', async () => {
    globalThis.fetch = (async () =>
      json({ five_hour: { resets_at: '2026-09-06T12:00:00Z' }, seven_day: null })) as unknown as typeof fetch;

    const usage = await getUsage(OAUTH_TOKEN);
    expect(usage!.windows).toEqual([]);
    expect(usage!.note).toBeTruthy();
  });

  test('utilization over 100 does not draw a bar backwards', async () => {
    globalThis.fetch = (async () => json({ five_hour: { utilization: 118 } })) as unknown as typeof fetch;
    expect((await getUsage(OAUTH_TOKEN))!.windows[0]!.remainingFraction).toBe(0);
  });

  test('resets_at as unix seconds is read as seconds, not milliseconds', async () => {
    globalThis.fetch = (async () =>
      json({ five_hour: { utilization: 1, resets_at: 1_757_160_000 } })) as unknown as typeof fetch;
    expect((await getUsage(OAUTH_TOKEN))!.windows[0]!.resetsAt).toBe(1_757_160_000_000);
  });
});

describe('not hammering a metered endpoint', () => {
  test('a second read inside the TTL does not make a second request', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return json({ five_hour: { utilization: 10 } });
    }) as unknown as typeof fetch;

    await getUsage(OAUTH_TOKEN);
    await getUsage(OAUTH_TOKEN);
    expect(requests).toBe(1);
  });

  test('concurrent reads share one request', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      await Bun.sleep(10);
      return json({ five_hour: { utilization: 10 } });
    }) as unknown as typeof fetch;

    await Promise.all([getUsage(OAUTH_TOKEN), getUsage(OAUTH_TOKEN), getUsage(OAUTH_TOKEN)]);
    expect(requests).toBe(1);
  });

  test('force bypasses the TTL, for an operator asking rather than a poll', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return json({ five_hour: { utilization: requests } });
    }) as unknown as typeof fetch;

    await getUsage(OAUTH_TOKEN);
    const second = await getUsage(OAUTH_TOKEN, { force: true });
    expect(requests).toBe(2);
    expect(second!.windows[0]!.utilizationPercent).toBe(2);
  });

  test('after a 429 the endpoint is left alone rather than retried into', async () => {
    // Retrying into a soft limit is how it becomes a hard one.
    const calls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      calls.push(String(url));
      if (String(url).includes('/api/oauth/usage')) return json({ error: 'slow down' }, 429);
      return json({ plan: 'pro' });
    }) as unknown as typeof fetch;

    await getUsage(OAUTH_TOKEN);
    await getUsage(OAUTH_TOKEN, { force: true });

    expect(calls.filter((u) => u.includes('/api/oauth/usage')).length).toBe(1);
  });
});

describe('when the reading cannot be taken', () => {
  test('a failed read returns the last good snapshot, not nothing', async () => {
    // A quota bar that vanishes on a transient error reads as "no limit" — the opposite of true.
    let attempt = 0;
    globalThis.fetch = (async () => {
      attempt++;
      if (attempt === 1) return json({ five_hour: { utilization: 55 } });
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await getUsage(OAUTH_TOKEN);
    const stale = await getUsage(OAUTH_TOKEN, { force: true });

    expect(stale!.windows[0]!.utilizationPercent).toBe(55);
  });

  test('a first read that fails with nothing cached yields null, and does not throw', async () => {
    // `getQuotas` must never be the reason a dashboard request fails.
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    expect(await getUsage(OAUTH_TOKEN)).toBeNull();
  });

  test('an empty credential asks nothing', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return json({});
    }) as unknown as typeof fetch;

    expect(await getUsage('   ')).toBeNull();
    expect(requests).toBe(0);
  });
});

describe('an API key, which has no consumer subscription behind it', () => {
  test('goes straight to the org endpoints rather than spending a guaranteed 401', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push(String(url));
      // An API key belongs on x-api-key. On `Authorization` it is a 401 that reads like an expiry.
      expect(init.headers['x-api-key']).toBe('sk-ant-api03-key');
      expect(init.headers.authorization).toBeUndefined();
      return json({ plan: 'enterprise', organization_name: 'Acme' });
    }) as unknown as typeof fetch;

    const usage = await getUsage('sk-ant-api03-key');

    expect(calls.some((u) => u.includes('/api/oauth/usage'))).toBe(false);
    expect(usage!.plan).toBe('enterprise');
    expect(usage!.organization).toBe('Acme');
    // No org id came back, so there is no cap to report — said in words rather than drawn as a bar.
    expect(usage!.note).toContain('admin');
  });

  test('org usage is carried through as reported, not reshaped into a cap nobody stated', async () => {
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes('/v1/settings')) {
        return json({ plan: 'enterprise', organization_id: 'org_1', organization_name: 'Acme' });
      }
      return json({ spend_cents: 4200 });
    }) as unknown as typeof fetch;

    const usage = await getUsage('sk-ant-api03-key');
    expect(usage!.extraUsage).toEqual({ spend_cents: 4200 });
    expect(usage!.windows).toEqual([]);
  });
});
