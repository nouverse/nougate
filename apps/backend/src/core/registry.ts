import type { IProtocolHandler, IProvider } from '@/core/interfaces';

const DEFAULT_PROVIDER_ID = 'antigravity';
const providers = new Map<string, IProvider>();
const handlers: IProtocolHandler[] = [];

/**
 * Register a provider instance in the global provider registry.
 */
export function registerProvider(provider: IProvider): void {
  if (providers.has(provider.id)) {
    console.warn(
      `[Registry] Provider "${provider.id}" already registered, overwriting.`,
    );
  }

  providers.set(provider.id, provider);
  console.log(
    `[Registry] Provider "${provider.id}" (${provider.displayName}) registered.`,
  );
}

/**
 * Retrieve a provider by its identifier.
 */
export function getProvider(id: string): IProvider | undefined {
  return providers.get(id);
}

/**
 * Retrieve the default provider used by the application.
 */
export function getDefaultProvider(): IProvider {
  const provider = providers.get(DEFAULT_PROVIDER_ID);

  if (!provider) {
    throw new Error(
      `[Registry] Default provider "${DEFAULT_PROVIDER_ID}" not registered.`,
    );
  }

  return provider;
}

/**
 * Return all registered providers.
 */
export function getAllProviders(): IProvider[] {
  return Array.from(providers.values());
}

/**
 * Register a protocol handler in the global handler registry.
 */
export function registerHandler(handler: IProtocolHandler): void {
  handlers.push(handler);
  console.log(
    `[Registry] Handler "${handler.protocol}" registered for paths: ` +
      `${handler.paths.join(', ')}`,
  );
}

/**
 * Find the first handler that matches the current request path and method.
 */
export function findHandler(
  pathname: string,
  method: string,
): IProtocolHandler | undefined {
  return handlers.find((handler) => {
    return (
      handler.methods.includes(method) &&
      handler.paths.some((path) => path === pathname)
    );
  });
}

/**
 * Return all registered protocol handlers.
 */
export function getAllHandlers(): IProtocolHandler[] {
  return [...handlers];
}
