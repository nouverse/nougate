import type { IProvider, ProviderExecuteParams } from '@/core/interfaces';
import { applyJitter } from '@/core/jitter';

/**
 * The one way a protocol handler reaches a provider.
 *
 * Everything that must happen to *every* upstream request, whoever serves it,
 * belongs here rather than in each provider's executor. Right now that is the
 * jitter delay: putting it here is what makes `BOTTOM_JITTER` an actual floor
 * instead of a suggestion each provider is free to reimplement or forget.
 *
 * The wait happens before `execute`, so a provider's own per-model timeout
 * starts counting after the delay rather than being eaten by it.
 */
export async function executeProviderRequest(
  provider: IProvider,
  params: ProviderExecuteParams,
): Promise<Response> {
  await applyJitter(provider.getJitterConfig());
  return provider.execute(params);
}
