import type { ResolvedModel } from '@/core/interfaces';


/**
 * Parse a client model string into provider and provider-local model ID parts.
 */
export function resolveModel(raw: string): ResolvedModel {
  const colonIndex = raw.indexOf(':');

  if (colonIndex > 0) {
    const maybeProvider = raw.substring(0, colonIndex);
    const modelId = raw.substring(colonIndex + 1);

    if (/^[a-z][a-z0-9_-]*$/.test(maybeProvider)) {
      return { providerId: maybeProvider, modelId, raw };
    }
  }

  return { providerId: null, modelId: raw, raw };
}

/**
 * Ensure that a parsed model includes an explicit provider prefix.
 */
export function requireProviderPrefix(resolved: ResolvedModel): void {
  if (resolved.providerId === null) {
    throw new ModelPrefixError(resolved.raw);
  }
}


/**
 * Format a provider-local model ID into its public provider-prefixed form.
 */
export function formatModelId(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

/**
 * Error raised when a client omits the required provider prefix.
 */
export class ModelPrefixError extends Error {
  readonly status = 400;

  constructor(raw: string) {
    super(
      `Model must include provider prefix. Got: "${raw}". Expected format: ` +
        `"provider:model-id" (e.g. "antigravity:gemini-3.5-flash-low").`,
    );
    this.name = 'ModelPrefixError';
  }
}
