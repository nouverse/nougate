import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

import { ProviderUnavailableError } from '@/core/upstream-errors';
import { AllKeysCoolingError, shortestCooldownMs } from '@/providers/custom/executor';
import type { CustomProviderKeyRecord } from '@/providers/custom/store';

const src = (path: string) => readFileSync(join(import.meta.dir, '../../src', path), 'utf8');

function key(overrides: Partial<CustomProviderKeyRecord>): CustomProviderKeyRecord {
  return {
    id: 'k1',
    providerId: 'p',
    label: 'primary',
    apiKey: 'sk-x',
    healthScore: 100,
    lastUsed: 0,
    cooldownUntil: 0,
    consecutiveFailures: 0,
    tokenUsage: 0,
    createdAt: 0,
    ...overrides,
  } as CustomProviderKeyRecord;
}

/**
 * Fixes for defects that made the gateway unstable rather than merely wrong.
 * Each block names the failure it prevents.
 */

describe('a custom provider stops hammering an upstream that rate limited it', () => {
  test('the wait is reported, not swallowed', () => {
    const error = new AllKeysCoolingError('deepseek', 45_000);

    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(45);
    expect(error.message).toContain('45s');
  });

  test('a sub-second wait still rounds up to a usable Retry-After', () => {
    // A `Retry-After: 0` would invite an immediate retry, which is the loop
    // this fix exists to break.
    expect(new AllKeysCoolingError('p', 200).retryAfterSeconds).toBe(1);
  });

  test('the shortest remaining cooldown is the one worth waiting for', () => {
    const now = Date.now();
    const wait = shortestCooldownMs(
      [key({ id: 'a', cooldownUntil: now + 60_000 }), key({ id: 'b', cooldownUntil: now + 5_000 })],
      now,
    );
    expect(Math.round(wait / 1000)).toBe(5);
  });

  test('a free key means no wait at all', () => {
    const now = Date.now();
    expect(shortestCooldownMs([key({ cooldownUntil: 0 })], now)).toBe(0);
    expect(shortestCooldownMs([], now)).toBe(0);
  });

  test('selection no longer falls back onto a cooling key', () => {
    // The old comment said it preferred a cooling key "rather than failing the
    // request outright" — which meant a single-key provider ignored its own
    // cooldown entirely.
    expect(src('providers/custom/executor.ts')).not.toContain(
      'keys.filter((key) => !excludeIds.includes(key.id))',
    );
  });

  test('only a rate limit earns a cooldown, not a transient 503', () => {
    const text = src('providers/custom/executor.ts');
    expect(text).toContain('if (statusCode === 429) {');
    expect(text).not.toContain('statusCode === 429 || statusCode === 503');
  });
});

describe('every provider bounds its own upstream request', () => {
  test('Copilot finally uses the timeout its model specs declare', () => {
    // Copilot declared timeoutMs on every spec and read it nowhere. With the
    // server running at idleTimeout: 0, a stalled connection hung forever.
    const text = src('providers/copilot/upstream/executor.ts');
    expect(text).toContain('new AbortController()');
    expect(text).toContain('options.modelSpec.timeoutMs');
    expect(text).toContain('signal: controller.signal');
  });

  test('all three providers abort rather than hang', () => {
    for (const path of [
      'providers/antigravity/upstream/executor.ts',
      'providers/copilot/upstream/executor.ts',
      'providers/custom/executor.ts',
    ]) {
      expect(src(path)).toContain('AbortController');
    }
  });
});

describe('streamed responses release the upstream connection', () => {
  test('manual reader loops cancel in a finally', () => {
    // A throw mid-loop used to leave the upstream response open with nothing
    // holding a reference to close it.
    for (const path of [
      'providers/antigravity/index.ts',
      'providers/antigravity/mappers/anthropic-out.ts',
    ]) {
      expect(src(path)).toContain('await reader.cancel()');
    }
  });
});

describe('usage figures say when they were guessed', () => {
  test('a row is exact only when neither side had to be estimated', () => {
    // `reportedByUpstream` flips as soon as either side arrives, so a provider
    // sending only output tokens produced a row marked exact whose input was
    // quietly an estimate.
    const text = src('core/metrics/tracker.ts');
    expect(text).toContain('!hasRealInput || !hasRealOutput');
  });

  test('the Anthropic mapper reports input tokens on both exit paths', () => {
    // The [DONE] path always did; the flush path did not, so any upstream that
    // ended without a [DONE] line looked like it consumed no input.
    const text = src('core/mappers/anthropic-to-openai.ts');
    const deltas = text.match(/usage: \{ input_tokens: inputTokens, output_tokens: outputTokens \}/g) ?? [];
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    expect(text).not.toContain('usage: { output_tokens: outputTokens },');
  });
});
