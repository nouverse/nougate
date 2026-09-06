/**
 * Claude thinking signature validation — E/R form prefix and marker byte checks.
 */

import { describe, expect, test } from 'bun:test';
import {
  hasClaudeSignaturePrefix,
  isValidClaudeSignature,
  CLAUDE_SIGNATURE_MARKER,
  DEFAULT_THINKING_CLAUDE_SIGNATURE,
} from '@/providers/claude-code/upstream/signature';

describe('hasClaudeSignaturePrefix', () => {
  test('returns true for E-prefixed strings', () => {
    expect(hasClaudeSignaturePrefix('EpwGCkYI...')).toBe(true);
  });

  test('returns true for R-prefixed strings', () => {
    expect(hasClaudeSignaturePrefix('RpwGCkYI...')).toBe(true);
  });

  test('returns false for other prefixes', () => {
    expect(hasClaudeSignaturePrefix('ApwGCkYI...')).toBe(false);
    expect(hasClaudeSignaturePrefix('')).toBe(false);
  });

  test('strips #sig cache prefix before checking', () => {
    expect(hasClaudeSignaturePrefix('cache#EpwGCkYI')).toBe(true);
    // stripCachePrefix takes everything after the first '#', so 'prefix#sig#EpwGCkYI'
    // becomes 'sig#EpwGCkYI', which itself strips to 'EpwGCkYI' — still valid.
    expect(hasClaudeSignaturePrefix('prefix#EpwGCkYI')).toBe(true);
  });
});

describe('isValidClaudeSignature', () => {
  test('validates E-form — base64 decoded first byte is 0x12', () => {
    // Build a minimal valid E-form: base64 of a buffer starting with 0x12
    const buf = Buffer.from([CLAUDE_SIGNATURE_MARKER, 0x00, 0x01]);
    const sig = buf.toString('base64');
    expect(sig[0]).toBe('E'); // base64 of 0x12... starts with 'E'
    expect(isValidClaudeSignature(sig)).toBe(true);
  });

  test('rejects E-form with wrong marker', () => {
    const buf = Buffer.from([0x13, 0x00, 0x01]);
    const sig = buf.toString('base64');
    // Only valid if sig starts with E — this particular one may not, so build one that does
    // Actually 0x13 base64 = 'E' prefix too... let's use 0x10 which won't start with E
    expect(isValidClaudeSignature('EAAAA')).toBe(false); // decodes but marker is 0x10
  });

  test('rejects empty strings', () => {
    expect(isValidClaudeSignature('')).toBe(false);
  });

  test('rejects non-E/R prefixed strings', () => {
    expect(isValidClaudeSignature('AAAA')).toBe(false);
    expect(isValidClaudeSignature('ZZZZ')).toBe(false);
  });

  test('the default Claude signature passes validation', () => {
    expect(isValidClaudeSignature(DEFAULT_THINKING_CLAUDE_SIGNATURE)).toBe(true);
  });

  test('strips cache prefix before validating', () => {
    const buf = Buffer.from([CLAUDE_SIGNATURE_MARKER, 0xAB, 0xCD]);
    const sig = buf.toString('base64');
    expect(isValidClaudeSignature(`cache#${sig}`)).toBe(true);
  });

  test('rejects signatures exceeding MAX_CLAUDE_SIGNATURE_LEN', () => {
    // 33MB string
    const huge = 'E' + 'A'.repeat(33 * 1024 * 1024);
    expect(isValidClaudeSignature(huge)).toBe(false);
  });
});
