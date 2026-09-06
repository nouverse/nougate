/**
 * Whether a custom provider joins bare-model routing on its own.
 *
 * Nothing in `core/smart-routing.ts` mentions custom providers, which is the point — it walks the
 * registry, and a custom provider is a registry entry like any other. But "it should follow from the
 * design" is exactly the claim worth checking against the real `CustomProvider`, because it is the
 * one provider whose model registry deliberately answers for models it was never told about:
 * `bypassModelValidation` makes `getSpec()` return a spec for *any* id, so discovery through that
 * method would hand every unprefixed request to whichever custom provider happens to be registered.
 *
 * Exercised with the actual class and store rather than a stand-in, since a stand-in cannot reproduce
 * that behaviour or the enable/disable lifecycle.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { IAccount, IProvider } from '@/core/interfaces';

const STATE_DIR = mkdtempSync(join(tmpdir(), 'nougate-routing-custom-'));
process.env.NOUGATE_DB_PATH = join(STATE_DIR, 'routing-custom.db');

const { loadProxyConfig, updateProxyConfig, getProxyConfig } = await import('@/config/manager');
const { initDb, closeDb } = await import('@/core/db');
const store = await import('@/providers/custom/store');
const { syncCustomProvider, removeCustomProviderInstance } = await import(
  '@/providers/custom/manager'
);
const { registerProvider, unregisterProvider, getAllProviders } = await import('@/core/registry');
const { projectPath } = await import('@/core/paths');
const { resolveModel } = await import('@/core/model-resolver');
const { routeCandidates, smartRoutableModels } = await import('@/core/smart-routing');

const NO_JITTER = { jitterEnabled: false, jitterMinMs: 0, jitterMaxMs: 0 };

/** A stand-in for a built-in provider, so the fan-out has something to fan out *from*. */
function builtIn(id: string, models: string[]): IProvider {
  const accounts: IAccount[] = [{ id: `${id}-1`, providerId: id, healthScore: 100, lastUsed: 0 }];
  const provider: IProvider = {
    id,
    displayName: id,
    init: async () => {},
    getJitterConfig: () => NO_JITTER,
    getBestAccount: async () => accounts[0]!,
    updateAccountUsage: async () => {},
    getAccounts: () => accounts,
    getModelRegistry: () => ({
      getSpec: (modelId: string) =>
        models.includes(modelId)
          ? {
              modelId,
              displayName: modelId,
              pool: 'cli',
              isThinking: false,
              maxOutputTokens: 1024,
              upstreamModelId: modelId,
              timeoutMs: 1000,
            }
          : null,
      listModelIds: () => [...models],
    }),
    getSupportedModels: () => [...models],
    execute: async () => new Response('ok'),
  };
  registerProvider(provider);
  return provider;
}

/** Create a custom provider in the store and register it the way the dashboard does. */
async function customProvider(
  id: string,
  models: string[],
  options: { withKey?: boolean } = {},
): Promise<void> {
  const record = await store.createCustomProvider({
    id,
    displayName: id,
    baseUrl: 'https://example.invalid/v1',
    apiStyle: 'openai',
  });
  if (options.withKey !== false) {
    await store.addProviderKey(id, `sk-test-${id}`, 'primary');
  }
  await store.upsertProviderModels(
    id,
    models.map((modelId) => ({ modelId, displayName: modelId })),
  );
  await syncCustomProvider(record);
}

const createdCustom: string[] = [];
const createdBuiltIn: string[] = [];

beforeAll(async () => {
  await loadProxyConfig();
  await initDb();
});

afterEach(async () => {
  while (createdBuiltIn.length > 0) unregisterProvider(createdBuiltIn.pop()!);
  while (createdCustom.length > 0) {
    const id = createdCustom.pop()!;
    removeCustomProviderInstance(id);
    await store.deleteCustomProvider(id);
  }
  await updateProxyConfig({ ...getProxyConfig(), bypassModelValidation: false });
});

afterAll(async () => {
  await closeDb();
  rmSync(STATE_DIR, { recursive: true, force: true });
});

describe('a custom provider in bare-model routing', () => {
  test('joins the fan-out for a model it declares, with no wiring of its own', async () => {
    builtIn('builtin', ['shared-model']);
    createdBuiltIn.push('builtin');
    await customProvider('mirror', ['shared-model', 'mirror-only']);
    createdCustom.push('mirror');

    const candidates = routeCandidates(resolveModel('shared-model'));
    expect(candidates.map((c) => c.provider.id)).toEqual(['builtin', 'mirror']);

    // And on its own for a model only it has.
    expect(routeCandidates(resolveModel('mirror-only')).map((c) => c.provider.id)).toEqual([
      'mirror',
    ]);
  });

  test('is tried last, because boot registers custom providers after the built-ins', () => {
    // Routing order is registration order, so this claim rests entirely on `boot.ts` — and the
    // ordering there is the safe direction: a custom provider is a *fallback* for a model a built-in
    // already serves, never a silent replacement for it. Asserted against the source rather than by
    // registering two providers in a test, which would only prove that a list keeps its own order.
    const boot = readFileSync(projectPath('apps/backend/src/boot.ts'), 'utf8');

    const lastBuiltIn = Math.max(
      ...['AntigravityProvider', 'CodexProvider', 'ClaudeCodeProvider', 'CopilotProvider'].map(
        (name) => boot.indexOf(`registerProvider(${name.charAt(0).toLowerCase()}`),
      ),
    );
    const customInit = boot.indexOf('initCustomProviders()');

    expect(lastBuiltIn).toBeGreaterThan(-1);
    expect(customInit).toBeGreaterThan(lastBuiltIn);
  });

  test('with no keys it is not a candidate, because it has no way to call anything', async () => {
    builtIn('builtin', ['shared-model']);
    createdBuiltIn.push('builtin');
    await customProvider('keyless', ['shared-model'], { withKey: false });
    createdCustom.push('keyless');

    expect(routeCandidates(resolveModel('shared-model')).map((c) => c.provider.id)).toEqual([
      'builtin',
    ]);
  });

  test('bypassModelValidation does not make it swallow every bare request', async () => {
    // The trap this whole design avoids: with the bypass on, `getSpec()` answers for anything, so
    // discovery via that method would route every unprefixed model to this provider.
    await updateProxyConfig({ ...getProxyConfig(), bypassModelValidation: true });

    builtIn('builtin', ['shared-model']);
    createdBuiltIn.push('builtin');
    await customProvider('catchall', ['declared-only']);
    createdCustom.push('catchall');

    // It answers getSpec for a model it never declared...
    const registry = getAllProviders().find((p) => p.id === 'catchall')!.getModelRegistry();
    expect(registry.getSpec('shared-model')).not.toBeNull();

    // ...and is still not a routing candidate for it.
    expect(routeCandidates(resolveModel('shared-model')).map((c) => c.provider.id)).toEqual([
      'builtin',
    ]);
  });

  test('disabling it removes it from routing without a restart', async () => {
    builtIn('builtin', ['shared-model']);
    createdBuiltIn.push('builtin');
    await customProvider('mirror', ['shared-model']);
    createdCustom.push('mirror');

    expect(smartRoutableModels().get('shared-model')).toEqual(['builtin', 'mirror']);

    // What the dashboard's enable toggle does: the record is saved, then re-synced.
    const disabled = await store.updateCustomProvider('mirror', { enabled: false });
    await syncCustomProvider(disabled!);

    expect(routeCandidates(resolveModel('shared-model')).map((c) => c.provider.id)).toEqual([
      'builtin',
    ]);
    // No longer worth offering as "smart routable" either — one candidate is left.
    expect(smartRoutableModels().get('shared-model')).toEqual(['builtin']);
  });
});
