/**
 * The two ways a token refresh kills an account that was fine, and the code that prevents each.
 *
 * Both failures here are silent in production and expensive to diagnose: the account simply stops
 * working some hours after a refresh that appeared to succeed. They are tested together because they
 * are the same underlying mistake — treating a refresh as an ordinary idempotent HTTP call, when
 * Anthropic rotates the token and revokes the family on reuse.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  classifyRefreshError,
  isPermanentRefreshFailure,
  TokenRefreshError,
} from '@/providers/cc/auth/refresh-errors';
import { createSingleFlight } from '@/providers/cc/auth/single-flight';
import { refreshTokens, resetRefreshDedup } from '@/providers/cc/auth/oauth';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  resetRefreshDedup();
});

/** A JSON Response, which is all the token endpoint ever returns. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('deciding whether a failed refresh means "sign in again"', () => {
  test('a stated invalid_grant is permanent', () => {
    expect(classifyRefreshError(JSON.stringify({ error: 'invalid_grant' }), 400).permanent).toBe(true);
  });

  test('a reused refresh token is permanent — the whole grant family is gone', () => {
    const failure = classifyRefreshError(
      JSON.stringify({ error: { code: 'refresh_token_reused', message: 'already used' } }),
      400,
    );
    expect(failure.permanent).toBe(true);
    expect(failure.code).toBe('refresh_token_reused');
  });

  test('a 500 is NOT permanent — this is the case that retires working subscriptions', () => {
    // The whole point of the classifier. `invalidate()` is permanent and only an operator undoes it,
    // so spending it on an upstream hiccup costs a manual sign-in for a credential that was fine.
    expect(classifyRefreshError('upstream had a moment', 500).permanent).toBe(false);
  });

  test('a body that is not JSON at all does not throw and is not permanent', () => {
    // A captive portal or a proxy returns HTML. A classifier that throws here turns a hiccup into an
    // unhandled rejection on the refresh path.
    const failure = classifyRefreshError('<html><body>502 Bad Gateway</body></html>', 502);
    expect(failure.permanent).toBe(false);
    expect(failure.status).toBe(502);
  });

  test('an empty body is not permanent', () => {
    expect(classifyRefreshError('', 0).permanent).toBe(false);
  });

  test('a long body is truncated before it reaches a log line', () => {
    expect(classifyRefreshError('x'.repeat(5000), 400).description.length).toBeLessThanOrEqual(300);
  });

  test('only a TokenRefreshError can be permanent — a stray TypeError says nothing about the grant', () => {
    expect(isPermanentRefreshFailure(new TypeError('fetch failed'))).toBe(false);
    expect(isPermanentRefreshFailure(undefined)).toBe(false);
    expect(
      isPermanentRefreshFailure(new TokenRefreshError(classifyRefreshError('{"error":"invalid_grant"}', 400))),
    ).toBe(true);
  });
});

describe('single-flight, which is what stops a rotated token being spent twice', () => {
  test('concurrent callers share one call', async () => {
    const flight = createSingleFlight<string>(10_000);
    let calls = 0;
    const slow = async () => {
      calls++;
      await Bun.sleep(10);
      return 'token';
    };

    const results = await Promise.all([
      flight.run('key', slow),
      flight.run('key', slow),
      flight.run('key', slow),
    ]);

    expect(results).toEqual(['token', 'token', 'token']);
    expect(calls).toBe(1);
  });

  test('a caller arriving just after the first finished gets the same answer, not a second call', async () => {
    // The gap the in-flight map alone does not close: this caller is holding the pre-refresh copy of
    // the account, sees the old expiry, and would present the token that was just rotated away.
    const flight = createSingleFlight<string>(10_000);
    let calls = 0;
    const fn = async () => {
      calls++;
      return 'token';
    };

    expect(await flight.run('key', fn)).toBe('token');
    expect(await flight.run('key', fn)).toBe('token');
    expect(calls).toBe(1);
  });

  test('different keys do not share anything', async () => {
    const flight = createSingleFlight<string>(10_000);
    expect(await flight.run('a', async () => 'first')).toBe('first');
    expect(await flight.run('b', async () => 'second')).toBe('second');
  });

  test('a failure is not remembered, so the next caller genuinely retries', async () => {
    // Caching a transient failure would block recovery for the whole TTL, while retrying a genuinely
    // dead token costs one HTTP 400.
    const flight = createSingleFlight<string>(10_000);
    let calls = 0;

    await expect(
      flight.run('key', async () => {
        calls++;
        throw new Error('network down');
      }),
    ).rejects.toThrow('network down');

    expect(await flight.run('key', async () => 'recovered')).toBe('recovered');
    expect(calls).toBe(1);
  });

  test('a settled result expires', async () => {
    const flight = createSingleFlight<number>(5);
    expect(await flight.run('key', async () => 1)).toBe(1);
    await Bun.sleep(15);
    expect(await flight.run('key', async () => 2)).toBe(2);
  });
});

describe('refreshTokens', () => {
  test('two concurrent refreshes of one credential make exactly one request', async () => {
    // Without this, the second request presents a token the first has already spent, Anthropic
    // answers `refresh_token_reused`, and the account dies minutes after a successful refresh.
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      await Bun.sleep(10);
      return json({ access_token: 'sk-ant-oat01-new', refresh_token: 'next', expires_in: 3600 });
    }) as unknown as typeof fetch;

    const [first, second] = await Promise.all([
      refreshTokens('current-refresh-token'),
      refreshTokens('current-refresh-token'),
    ]);

    expect(requests).toBe(1);
    expect(first.access_token).toBe('sk-ant-oat01-new');
    expect(second.access_token).toBe('sk-ant-oat01-new');
  });

  test('a rejected grant throws a permanent TokenRefreshError', async () => {
    globalThis.fetch = (async () => json({ error: 'invalid_grant' }, 400)) as unknown as typeof fetch;

    const error = await refreshTokens('dead-token').catch((e) => e);
    expect(error).toBeInstanceOf(TokenRefreshError);
    expect(isPermanentRefreshFailure(error)).toBe(true);
  });

  test('a 500 throws, but not permanently — the account must survive it', async () => {
    globalThis.fetch = (async () => new Response('gateway timeout', { status: 504 })) as unknown as typeof fetch;

    const error = await refreshTokens('good-token').catch((e) => e);
    expect(error).toBeInstanceOf(TokenRefreshError);
    expect(isPermanentRefreshFailure(error)).toBe(false);
  });

  test('a 200 carrying no access_token is a failure, not a credential of undefined', async () => {
    // Letting this through writes `undefined` onto the account, which 401s every later request and
    // gets diagnosed as an expiry — chasing entirely the wrong thing.
    globalThis.fetch = (async () => json({ token_type: 'Bearer' })) as unknown as typeof fetch;

    const error = await refreshTokens('odd-token').catch((e) => e);
    expect(error).toBeInstanceOf(TokenRefreshError);
    expect((error as TokenRefreshError).failure.code).toBe('no_access_token');
  });

  test('the request is JSON and carries the client id, which is what the endpoint requires', async () => {
    let sent: any = null;
    globalThis.fetch = (async (_url: any, init: any) => {
      sent = { headers: init.headers, body: JSON.parse(init.body) };
      return json({ access_token: 'sk-ant-oat01-new' });
    }) as unknown as typeof fetch;

    await refreshTokens('a-refresh-token');

    // Form-encoding here is a 400 that does not say why.
    expect(sent.headers['Content-Type']).toBe('application/json');
    expect(sent.body.grant_type).toBe('refresh_token');
    expect(sent.body.refresh_token).toBe('a-refresh-token');
    expect(sent.body.client_id).toBeTruthy();
    // There is no client secret to send, and an empty one is a 401.
    expect(sent.body.client_secret).toBeUndefined();
  });
});
