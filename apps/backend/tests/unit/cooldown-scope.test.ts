import { describe, expect, test } from 'bun:test';

import * as antigravity from '@/providers/antigravity/auth/manager';
import * as copilot from '@/providers/copilot/auth/manager';

/**
 * Cooldowns are scoped to a *model*, with one account-wide scope for "bench
 * this whole account".
 *
 * Two live bugs made this worth pinning down:
 *
 *  - Copilot wrote its 429 cooldown under the model id but read it back under
 *    the family name, so the lock was invisible and the account was picked
 *    again on the very next request.
 *  - Antigravity's manual cooldown passed the duration into the scope
 *    argument, writing a key nothing ever read — and silently using the default
 *    duration instead of the one asked for.
 *
 * Both providers keep the same shape on purpose; these tests run against each.
 */

const providers: Array<{ name: string; mod: typeof antigravity }> = [
  { name: 'antigravity', mod: antigravity },
  { name: 'copilot', mod: copilot as unknown as typeof antigravity },
];

describe.each(providers)('$name cooldown scoping', ({ mod }) => {
  test('a model scope is the model id, lowercased', () => {
    expect(mod.cooldownScope('Gemini-3-Pro')).toBe('gemini-3-pro');
    expect(mod.cooldownScope('  claude-opus-4.6  ')).toBe('claude-opus-4.6');
  });

  test('no model means the whole account', () => {
    // The scope an operator gets when they press "Cooldown" in the dashboard.
    expect(mod.cooldownScope()).toBe(mod.ACCOUNT_WIDE);
    expect(mod.cooldownScope(undefined)).toBe(mod.ACCOUNT_WIDE);
  });

  test('two models never share a scope', () => {
    // The whole point: a limit on Pro must not bench Flash with it. Keying on
    // the family name did exactly that.
    expect(mod.cooldownScope('gemini-3-pro')).not.toBe(mod.cooldownScope('gemini-3-flash'));
    expect(mod.cooldownScope('claude-opus-4.6')).not.toBe(mod.cooldownScope('claude-sonnet-4.5'));
  });

  test('a model scope is never the account-wide scope', () => {
    // Otherwise one model's rate limit would bench every model on the account.
    for (const model of ['gemini-3-pro', 'gpt-4o', 'claude-opus-4.6']) {
      expect(mod.cooldownScope(model)).not.toBe(mod.ACCOUNT_WIDE);
    }
  });

  test('the same model always resolves to the same key', () => {
    // Set and check must agree, which is precisely what Copilot got wrong.
    const written = mod.cooldownScope('Claude-Opus-4.6');
    const read = mod.cooldownScope('claude-opus-4.6');
    expect(written).toBe(read);
  });
});

describe('the family helper is no longer a cooldown key', () => {
  test('families still exist, but only for quota grouping', () => {
    // getFamilyName still matches Antigravity's quota groupNames, but it must
    // never come back as a cooldown scope. One family spans models from
    // different vendors, so keying cooldowns on it meant a rate limit on
    // Claude Opus also benched every GPT model on that account.
    expect(antigravity.getFamilyName('claude-opus-4.6')).toBe('Claude/GPT');
    expect(antigravity.getFamilyName('gpt-4o')).toBe('Claude/GPT');
    expect(antigravity.cooldownScope('claude-opus-4.6')).not.toBe(
      antigravity.getFamilyName('claude-opus-4.6'),
    );
  });
});
