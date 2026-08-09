import { describe, expect, test } from 'bun:test';
import { classifyUpstreamError } from '@/core/upstream-errors';

/**
 * The classifier decides three things the gateway acts on: retry or not,
 * rotate to another account or not, and whether the failure belongs to the
 * model or the whole account. Getting the third one wrong is what makes a
 * limit on one model take an account out of rotation entirely.
 */

describe('rate limiting', () => {
  test('separates a spent allowance from going too fast', () => {
    const quota = classifyUpstreamError({
      status: 429,
      body: '{"error":{"status":"RESOURCE_EXHAUSTED","message":"quota exceeded"}}',
    });
    expect(quota.kind).toBe('quota_exhausted');

    // A bare 429 with no quota language is a speed limit, which clears in
    // seconds — cooling the account for an hour would be wrong.
    const paced = classifyUpstreamError({ status: 429, body: 'slow down' });
    expect(paced.kind).toBe('rate_limited');

    // Both are the model's problem, not the account's.
    expect(quota.modelScoped).toBe(true);
    expect(paced.modelScoped).toBe(true);
  });

  test('recognises Google\'s detail-array wording', () => {
    const body = '{"error":{"details":[{"reason":"RATE_LIMIT_EXCEEDED"}]}}';
    expect(classifyUpstreamError({ status: 429, body }).kind).toBe('quota_exhausted');
  });

  test('recognises the bot-detection body Google returns as text', () => {
    const body = 'Our systems have detected unusual traffic — automated queries';
    expect(classifyUpstreamError({ status: 429, body }).kind).toBe('quota_exhausted');
  });
});

describe('capacity and server errors', () => {
  test('an overloaded model is scoped to the model', () => {
    const result = classifyUpstreamError({ status: 503, body: '{"error":"model is overloaded"}' });
    expect(result.kind).toBe('model_capacity');
    expect(result.modelScoped).toBe(true);
    expect(result.retryable).toBe(true);
  });

  test('a plain 5xx is the account\'s whole upstream, not one model', () => {
    const result = classifyUpstreamError({ status: 500, body: 'Internal Server Error' });
    expect(result.kind).toBe('server_error');
    expect(result.modelScoped).toBe(false);
  });
});

describe('credentials and unknown models', () => {
  test('a rejected credential is worth trying another account', () => {
    for (const status of [401, 403]) {
      const result = classifyUpstreamError({ status });
      expect(result.kind).toBe('auth');
      expect(result.rotate).toBe(true);
      expect(result.retryable).toBe(false);
    }
  });

  test('an unknown model must not burn every account', () => {
    const result = classifyUpstreamError({
      status: 404,
      body: '{"error":{"message":"model not found"}}',
    });
    expect(result.kind).toBe('model_unsupported');
    // Every account would answer identically, so rotating just wastes them.
    expect(result.rotate).toBe(false);
    expect(result.retryable).toBe(false);
  });
});

describe('failures before a response', () => {
  test('a timeout blames the wait, not the account', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const result = classifyUpstreamError({ error: abort });

    expect(result.kind).toBe('timeout');
    expect(result.retryable).toBe(true);
    // Rotating on a timeout spreads one slow request across the whole pool.
    expect(result.rotate).toBe(false);
  });

  test('a connection failure is worth another account', () => {
    const result = classifyUpstreamError({ error: new TypeError('fetch failed') });
    expect(result.kind).toBe('network');
    expect(result.rotate).toBe(true);
  });
});

describe('the unknown case', () => {
  test('an unrecognised failure is not retried forever', () => {
    // Silently retrying something we cannot explain hides new failure modes.
    const result = classifyUpstreamError({ status: 418, body: 'teapot' });
    expect(result.kind).toBe('unknown');
    expect(result.retryable).toBe(false);
    expect(result.rotate).toBe(false);
  });

  test('every classification carries a sentence worth showing an operator', () => {
    const inputs = [
      { status: 429, body: 'quota' },
      { status: 503, body: 'overloaded' },
      { status: 401 },
      { status: 500 },
      { error: new Error('boom') },
      { status: 418 },
    ];

    for (const input of inputs) {
      const { message } = classifyUpstreamError(input);
      expect(message.length).toBeGreaterThan(10);
    }
  });
});
