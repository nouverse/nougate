/**
 * Antigravity client version — Google answers a client older than its supported floor with
 * "This version of Antigravity is no longer supported" as the reply, so every request must
 * claim the current IDE release (2.6.0), not the old 2.0.1 or the hub app's 2.0.6.
 */

import { describe, expect, test } from 'bun:test';
import { generateFingerprint, getClientHeaders } from '@/providers/antigravity/upstream/headers';

describe('Antigravity client version', () => {
  test('the IDE User-Agent claims 2.6.0', () => {
    const headers = getClientHeaders('token', generateFingerprint('a@example.com'));
    expect(headers['User-Agent']).toContain('Antigravity/2.6.0 ');
  });

  test('a new fingerprint carries the same version', () => {
    expect(generateFingerprint().userAgent).toStartWith('antigravity/2.6.0 ');
  });
});
