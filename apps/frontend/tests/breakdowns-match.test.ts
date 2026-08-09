import { describe, expect, test } from 'bun:test';
import { breakdownsMatch } from '@/routes/tokens';

/**
 * The client ID falls back to the API key's name when a caller sends no
 * `x-client-id`, so with nobody setting that header the "spend by client" and
 * "spend by API key" panels are the same numbers under different labels.
 * Showing both then reads as a duplicated-data bug, so the dashboard collapses
 * them — but only when they genuinely carry no extra information.
 */

const client = (clientId: string, requests: number, totalCost: number) => ({
  clientId,
  requests,
  totalCost,
});
const key = (name: string, requests: number, totalCost: number) => ({ name, requests, totalCost });

describe('client vs api-key breakdown', () => {
  test('matches when every client is just the key it authenticated with', () => {
    expect(
      breakdownsMatch(
        [client('openclaw', 26, 1.38), client('zed', 5, 0.07)],
        [key('openclaw', 26, 1.38), key('zed', 5, 0.07)],
      ),
    ).toBe(true);
  });

  test('treats "unknown" and "no key" as the same bucket', () => {
    // Two labels for one thing: a request with neither a header nor a key.
    expect(
      breakdownsMatch([client('unknown', 10, 0.16)], [key('no key', 10, 0.16)]),
    ).toBe(true);
  });

  test('keeps both panels when a caller sets its own client id', () => {
    // One key, two machines — exactly the case the client panel exists for.
    expect(
      breakdownsMatch(
        [client('laptop', 20, 1.0), client('ci', 6, 0.38)],
        [key('openclaw', 26, 1.38)],
      ),
    ).toBe(false);
  });

  test('a shared label with different spend is still a real difference', () => {
    // Same names, different numbers: the client is not merely echoing the key.
    expect(
      breakdownsMatch([client('openclaw', 26, 1.38)], [key('openclaw', 26, 0.99)]),
    ).toBe(false);
  });

  test('no data is not a match, so nothing is hidden on an empty dashboard', () => {
    expect(breakdownsMatch([], [])).toBe(false);
  });
});
