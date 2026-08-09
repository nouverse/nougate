import { afterEach, describe, expect, test } from 'bun:test';

import { getBaseUrl } from '@/core/base-url';

/**
 * The gateway's own URL decides where OAuth redirects land and whether session
 * cookies carry `Secure`, so the two things worth pinning are that a trailing
 * slash never doubles up in a built path, and that the fallback follows the port
 * the server actually listens on.
 */

const ORIGINAL_BASE_URL = process.env.BASE_URL;
const ORIGINAL_PORT = process.env.PORT;

afterEach(() => {
  if (ORIGINAL_BASE_URL === undefined) delete process.env.BASE_URL;
  else process.env.BASE_URL = ORIGINAL_BASE_URL;

  if (ORIGINAL_PORT === undefined) delete process.env.PORT;
  else process.env.PORT = ORIGINAL_PORT;
});

describe('getBaseUrl', () => {
  test('uses BASE_URL when it is set', () => {
    process.env.BASE_URL = 'https://nougate.nouverse.tech';
    expect(getBaseUrl()).toBe('https://nougate.nouverse.tech');
  });

  test('strips trailing slashes so callers can always append a path', () => {
    process.env.BASE_URL = 'https://nougate.nouverse.tech///';
    expect(`${getBaseUrl()}/frontend/`).toBe('https://nougate.nouverse.tech/frontend/');
  });

  test('falls back to localhost on the port the server listens on', () => {
    delete process.env.BASE_URL;
    process.env.PORT = '4000';
    expect(getBaseUrl()).toBe('http://localhost:4000');
  });

  test('falls back to port 3000 when neither is set', () => {
    delete process.env.BASE_URL;
    delete process.env.PORT;
    expect(getBaseUrl()).toBe('http://localhost:3000');
  });

  test('treats a blank BASE_URL as unset rather than as an empty origin', () => {
    // Compose writes `BASE_URL=` for an unset variable, and an empty string here
    // would build redirect URLs like "/frontend/" with no host at all.
    process.env.BASE_URL = '   ';
    process.env.PORT = '3000';
    expect(getBaseUrl()).toBe('http://localhost:3000');
  });
});
