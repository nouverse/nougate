/**
 * A list decides what is offered and where a bare id goes; an id asked for by name is still sent.
 *
 * Installs have agents pinned to ids (`codex:gpt-6-astra`, `codex:gpt-5.5`, `kiro:claude-opus-4.5`)
 * that their own plan may still be served though one account's list does not show them: a user runs
 * gpt-6-astra on his plan while the owner's Codex list lacks it. So a prefixed id a provider does not
 * list is forwarded to that provider with a default spec, and the upstream's own answer decides — a
 * refusal comes back as the error it is, costing no account (`upstream-errors`, each executor). A bare
 * id is routed only to the providers whose list has it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { IProvider } from '@/core/interfaces';
import { resolveModel } from '@/core/model-resolver';
import { getProvider, registerProvider, unregisterProvider } from '@/core/registry';
import { routeCandidates } from '@/core/smart-routing';
import { AntigravityProvider } from '@/providers/antigravity';
import { shapeOf } from '@/providers/antigravity/config/shape';
import { ClaudeCodeProvider } from '@/providers/claudecode';
import { CodexProvider } from '@/providers/codex';
import { CopilotProvider } from '@/providers/copilot';
import { KiroProvider } from '@/providers/kiro';
import { kiroModelRegistry } from '@/providers/kiro/config/model-specs';
import { clearSeeds } from './fixtures/upstream-models';

const providers: IProvider[] = [new CodexProvider(), new ClaudeCodeProvider(), new CopilotProvider(), new KiroProvider(), new AntigravityProvider()];
const before = new Map<string, IProvider | undefined>();
const realLog = console.log;
const realWarn = console.warn;

beforeAll(() => {
  console.log = () => {};
  console.warn = () => {};
  for (const provider of providers) {
    before.set(provider.id, getProvider(provider.id));
    registerProvider(provider);
  }
});

afterEach(() => clearSeeds());

afterAll(() => {
  for (const provider of providers) {
    unregisterProvider(provider.id);
    const previous = before.get(provider.id);
    if (previous) registerProvider(previous);
  }
  console.log = realLog;
  console.warn = realWarn;
});

/** The one candidate a prefixed id resolves to, and its spec. */
function routed(raw: string) {
  const candidates = routeCandidates(resolveModel(raw));
  expect(candidates.map((candidate) => candidate.provider.id)).toEqual([raw.split(':')[0]!]);
  return candidates[0]!.modelSpec;
}

describe('a prefixed id the provider does not list', () => {
  test.each([
    ['codex:gpt-6-astra', 'gpt-6-astra'],
    ['codex:gpt-5.5', 'gpt-5.5'],
    ['claudecode:claude-opus-9', 'claude-opus-9'],
    ['copilot:gpt-9-test', 'gpt-9-test'],
    ['kiro:claude-opus-4.5', 'claude-opus-4.5'],
    ['antigravity:gemini-9-test', 'gemini-9-test'],
  ])('%s is sent to that provider, as written, with a default spec', (raw, upstream) => {
    const spec = routed(raw);
    expect(spec.upstreamModelId ?? spec.modelId).toBe(upstream);
    expect(spec.maxOutputTokens).toBeGreaterThan(0);
    expect(spec.inputPricePer1M).toBeUndefined();
  });

  test('is not offered, and its bare id goes nowhere', () => {
    for (const provider of providers) {
      expect(provider.getModelRegistry().listModelIds()).not.toContain('gpt-6-astra');
    }
    expect(routeCandidates(resolveModel('gpt-6-astra'))).toEqual([]);
  });

  test('a Kiro variant of one is sent as its model, with the variant asked for', () => {
    const spec = routed('kiro:claude-opus-4.5-thinking');
    expect(spec).toMatchObject({ modelId: 'claude-opus-4.5-thinking', upstreamModelId: 'claude-opus-4.5', isThinking: true });
    expect(kiroModelRegistry.upstreamSpelling('claude-opus-4.5')).toBe('claude-opus-4.5');
  });

  test('Antigravity shapes one by reading its id, the one thing known', () => {
    expect(shapeOf(routed('antigravity:claude-next-test'))).toMatchObject({ anthropic: true, validatedTools: true });
    expect(shapeOf(routed('antigravity:gemini-9-test'))).toMatchObject({ anthropic: false, callIds: true, signatures: true });
    expect(shapeOf(routed('antigravity:gemini-2.5-test'))).toMatchObject({ callIds: false, signatures: false });
  });

  test('Claude Code sends an undated id it has no snapshot of as written', () => {
    expect(routed('claudecode:claude-opus-4.5')).toMatchObject({ modelId: 'claude-opus-4-5', upstreamModelId: 'claude-opus-4-5' });
  });
});
