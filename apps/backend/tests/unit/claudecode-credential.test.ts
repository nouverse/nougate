/**
 * Which header a credential belongs on.
 *
 * The whole provider rests on this, and getting it wrong produces the least readable failure in the
 * system: a 401 on a credential that is perfectly valid. Anthropic accepts two kinds and they are not
 * interchangeable — an API key on `Authorization: Bearer` is rejected, and an OAuth token without the
 * beta header is rejected by `/v1/messages` specifically.
 */

import { describe, expect, test } from 'bun:test';
import {
  authHeaders,
  credentialHint,
  credentialKind,
} from '@/providers/claudecode/auth/credential';

describe('telling the two kinds of credential apart', () => {
  test('an API key is recognised by its documented prefix', () => {
    expect(credentialKind('sk-ant-api03-abc123')).toBe('api-key');
  });

  test('anything else is treated as an OAuth access token', () => {
    // Deliberately open-ended: OAuth tokens have no stable shape to match on, so the API key is what
    // gets identified and everything else falls through. A new token format therefore keeps working.
    expect(credentialKind('sk-ant-oat01-abc123')).toBe('oauth');
    expect(credentialKind('eyJhbGciOiJIUzI1NiJ9.abc.def')).toBe('oauth');
  });

  test('surrounding whitespace does not change the answer', () => {
    // Pasted from a terminal, which is where these come from.
    expect(credentialKind('  sk-ant-api03-abc  ')).toBe('api-key');
  });
});

describe('the headers each kind goes out on', () => {
  test('an API key uses x-api-key and never Authorization', () => {
    const headers = authHeaders('sk-ant-api03-abc123');

    expect(headers['x-api-key']).toBe('sk-ant-api03-abc123');
    expect(headers.authorization).toBeUndefined();
    // No beta header: it is the OAuth path's requirement, and sending it here is noise on every call.
    expect(headers['anthropic-beta']).toBeUndefined();
  });

  test('an OAuth token uses Bearer AND the oauth beta header', () => {
    const headers = authHeaders('sk-ant-oat01-abc123');

    expect(headers.authorization).toBe('Bearer sk-ant-oat01-abc123');
    expect(headers['x-api-key']).toBeUndefined();
    // The forgotten half. /v1/messages 401s without it while the token is valid — the single most
    // confusing failure on this path, and the reason this assertion exists rather than a comment.
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
  });

  test('both carry the API version, which is required regardless of how you authenticated', () => {
    expect(authHeaders('sk-ant-api03-x')['anthropic-version']).toBe('2023-06-01');
    expect(authHeaders('token')['anthropic-version']).toBe('2023-06-01');
  });

  test('whitespace is stripped before the value reaches a header', () => {
    // A trailing newline off a shell pipeline would otherwise become part of the header value.
    expect(authHeaders(' token\n'.trim())['authorization']).toBe('Bearer token');
    expect(authHeaders(' token\n')['authorization']).toBe('Bearer token');
  });
});

describe('what is safe to show', () => {
  test('a hint keeps both ends and never the middle', () => {
    expect(credentialHint('sk-ant-api03-secretmiddle-xyz9')).toBe('sk-a…xyz9');
  });

  test('a short value is not partially revealed', () => {
    // Four-and-four out of six characters is most of the secret.
    expect(credentialHint('abc123')).toBe('…');
  });
});
