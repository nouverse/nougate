/**
 * Every provider a person signs in to says, in its own words, what a sign-in screen should show.
 *
 * Two screens draw the same sign-in without knowing any provider by name: this gateway's dashboard,
 * and a host's setup wizard (Nouride lists every provider with a sign-in flow under "Use Nougate LLM
 * Gateway"). Both read `accountCopy` off the provider. A provider that forgets it is still listed —
 * under its `displayName`, with neutral words — so nothing breaks; this test is what makes forgetting
 * it a failure here rather than a vague row in somebody's wizard.
 */

import { describe, expect, test } from 'bun:test';
import type { IProvider } from '@/core/interfaces';
import { AntigravityProvider } from '@/providers/antigravity';
import { ClaudeCodeProvider } from '@/providers/claudecode';
import { CodexProvider } from '@/providers/codex';
import { CopilotProvider } from '@/providers/copilot';
import { KiroProvider } from '@/providers/kiro';

const BUILT_IN: IProvider[] = [
  new AntigravityProvider(),
  new ClaudeCodeProvider(),
  new CodexProvider(),
  new CopilotProvider(),
  new KiroProvider(),
];

/** The flows a person completes on a sign-in screen — `api-key` is a custom provider's form, not this. */
const SIGN_IN = new Set(['oauth-redirect', 'device-code', 'oauth-token']);

describe('what a sign-in screen says, per provider', () => {
  const signIns = BUILT_IN.filter((provider) => SIGN_IN.has(provider.accountFlow ?? ''));

  test('there are some, so the rest of this means something', () => {
    expect(signIns.length).toBeGreaterThanOrEqual(5);
  });

  test('each names itself, says which account it takes, and where it goes in a list', () => {
    for (const provider of signIns) {
      const copy = provider.accountCopy;
      expect({ id: provider.id, label: copy?.label?.trim() }).toEqual({ id: provider.id, label: expect.any(String) });
      expect(copy!.label.trim().length).toBeGreaterThan(0);
      expect(copy!.hint.trim().length).toBeGreaterThan(0);
      expect(Number.isFinite(copy!.order)).toBe(true);
    }
  });

  test('no two share a place in the list', () => {
    const orders = signIns.map((provider) => provider.accountCopy!.order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  test('an OAuth sign-in says what happens after approving, and what to paste back', () => {
    // The tab ends on an address that, from the person's own machine, does not load. Saying so before
    // it happens is the difference between a step and a scare — and only the provider knows where.
    for (const provider of signIns.filter((p) => p.accountFlow === 'oauth-redirect')) {
      const copy = provider.accountCopy!;
      for (const field of ['title', 'intro', 'button', 'consent', 'pasteLabel', 'pastePlaceholder'] as const) {
        expect({ id: provider.id, field, present: Boolean(copy[field]?.trim()) }).toEqual({ id: provider.id, field, present: true });
      }
    }
  });

  test("no provider borrows another one's words", () => {
    // The bug this replaces: a Claude sign-in titled "Add Google Account".
    const labels = signIns.map((provider) => provider.accountCopy!.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const provider of signIns) {
      const others = signIns.filter((p) => p !== provider).map((p) => p.accountCopy!.label);
      for (const other of others) expect(provider.accountCopy!.title ?? '').not.toContain(other);
    }
  });
});
