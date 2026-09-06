/**
 * Claude thinking signature validation — E/R form prefix and marker byte checks.
 */

import { describe, expect, test } from 'bun:test';
import {
  isValidClaudeSignature,
  CLAUDE_SIGNATURE_MARKER,
} from '@/providers/cc/upstream/signature';

/**
 * A real signature, captured from a live session.
 *
 * A fixture rather than a constant in `src`: nothing in the request path substitutes a canned
 * signature — see the note in `mappers/thinking.ts` on why one is never pasted onto a block it did
 * not come from — so its only job is proving the validator accepts the genuine article.
 */
const REAL_CLAUDE_SIGNATURE =
  'EpwGCkYIChgCKkCzVUuRrg7CcglSUWEef4rH6o35g9UYS8ZPe0/VomQTBsFx6sttYNj5l8GqgW6ejuHyYqpFToxIbZl0bw17l5dJEgzCnqDO0Z8fRlMrNgsaDLS1cnCjC53KBqE0CCIwAADQdo1eO+7qPAmo8J4WR3JPmr92S97kmvr5K1iPMiOpkZNj8mEXW8uzBoOJs/9ZKoMFiqHJ3UObwaJDqFOW70E9oCwDoc6jesaWVAEdN5vWfKMpIkjFJjECdjIdkxyJNJ8Ib8yXVal3qwE7uThoPRqSZDdHB5mmwPEjWE/90cSYCbtX2YsJki1265CabBb8/QEkODXg4kgRrL+c8e8rRXz/dr1RswvaPuzEdGKHRNi9UooNUeOK4/ebx1KkP9YZttyohN9GWqlts36kOoW0Cfie/ABDgF9g534BPth/sstxDM6d79QlRmh6NxizyTF74DXJI34u0M4tTRchqE5pAq85SgdJaa+dix1yJPMji8m6nZkwJbscJb9rdc2MKyKWjz8QL2+rTSSuZ2F1k1qSsW0xNcI7qLcI12Vncfn/VqY6YOIZy/saZBR0ezXvN6g+UYbuIdyVg7AyIFZt3nbrO7/kmOEb2VKzygwklHGEIJHfFgMpH3JSrAzbZIowVHOF7VaJ+KXRFDCFin7hHTOiOsdg+1ij1mML9Z/x/9CP4b7OUcaQm1llDZPSHc6rZMNL3DdB+fW5YfmNgKU35S+7AMtA10nVILzDAk1UV4T2K9Do09JlI6rjOs9UuULlIN2Z0eE8YTlANR6uQcw7lMcdfqYE8tke4rDKc2dDiaS5vVe45VewICNpdXGN11yw8QqH7p27CR1HtN30e0tHXOR3bIwWk/Yb6O5fTaKG6Ri8e5ZCPvdD9HqepVi188nM0iTjJqL58F3ni04ECIhcbyaQWnuTes1Kw4CMwiZDLQkk8Hgz7HkUOf1btQTF/0nhD7ry0n0hAEg2PaDM3V6TjOjf4hEldRmeqERcQF1PfgKb6ZM12rlIIfUqKACczWJSzTV158+47HX36o0cgux6nFlv/DE+sEiRVxgB';

describe('isValidClaudeSignature', () => {
  test('validates E-form — base64 decoded first byte is 0x12', () => {
    // Build a minimal valid E-form: base64 of a buffer starting with 0x12
    const buf = Buffer.from([CLAUDE_SIGNATURE_MARKER, 0x00, 0x01]);
    const sig = buf.toString('base64');
    expect(sig[0]).toBe('E'); // base64 of 0x12... starts with 'E'
    expect(isValidClaudeSignature(sig)).toBe(true);
  });

  test('rejects E-form with wrong marker', () => {
    // 'EAAAA' has the E prefix and decodes cleanly, but the first byte is 0x10, not the marker.
    expect(isValidClaudeSignature('EAAAA')).toBe(false);
  });

  test('rejects empty strings', () => {
    expect(isValidClaudeSignature('')).toBe(false);
  });

  test('rejects non-E/R prefixed strings', () => {
    expect(isValidClaudeSignature('AAAA')).toBe(false);
    expect(isValidClaudeSignature('ZZZZ')).toBe(false);
  });

  test('a real captured signature passes validation', () => {
    expect(isValidClaudeSignature(REAL_CLAUDE_SIGNATURE)).toBe(true);
  });

  test('strips cache prefix before validating', () => {
    const buf = Buffer.from([CLAUDE_SIGNATURE_MARKER, 0xAB, 0xCD]);
    const sig = buf.toString('base64');
    expect(isValidClaudeSignature(`cache#${sig}`)).toBe(true);
  });

  test('rejects signatures past the 32MB ceiling', () => {
    // 33MB string
    const huge = 'E' + 'A'.repeat(33 * 1024 * 1024);
    expect(isValidClaudeSignature(huge)).toBe(false);
  });
});
