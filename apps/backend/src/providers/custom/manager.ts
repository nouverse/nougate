import { registerProvider, unregisterProvider } from '@/core/registry';
import { adminEventBus } from '@/core/events';
import { CustomProvider } from './index';
import { type CustomProviderRecord, getCustomProvider, listCustomProviders } from './store';

/** Live provider instances, keyed by provider ID. */
const instances = new Map<string, CustomProvider>();

/**
 * Register (or re-register) one custom provider in the core registry.
 * Disabled providers are unregistered instead, so they stop resolving models.
 */
export function syncCustomProvider(record: CustomProviderRecord): CustomProvider | null {
  if (!record.enabled) {
    removeCustomProviderInstance(record.id);
    return null;
  }

  const existing = instances.get(record.id);
  if (existing) {
    existing.refresh();
    return existing;
  }

  const provider = new CustomProvider(record);
  instances.set(record.id, provider);
  registerProvider(provider);
  return provider;
}

/**
 * Drop a custom provider from the registry.
 */
export function removeCustomProviderInstance(id: string): void {
  if (instances.delete(id)) {
    unregisterProvider(id);
  }
}

/**
 * Invalidate a provider's cached models/config after a dashboard edit.
 */
export function refreshCustomProvider(id: string): void {
  const record = getCustomProvider(id);
  if (!record) {
    removeCustomProviderInstance(id);
    return;
  }

  syncCustomProvider(record);
  instances.get(id)?.refresh();
}

export function getCustomProviderInstance(id: string): CustomProvider | undefined {
  return instances.get(id);
}

/**
 * Load every stored custom provider during startup.
 */
export function initCustomProviders(): void {
  let count = 0;

  for (const record of listCustomProviders()) {
    if (syncCustomProvider(record)) {
      count += 1;
    }
  }

  if (count > 0) {
    console.log(`[CustomProviders] Registered ${count} custom provider(s).`);
    adminEventBus.emit('update', {});
  }
}
