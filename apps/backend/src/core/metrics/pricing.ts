import type { IModelSpec } from '@/core/interfaces';
import { getProxyConfig } from '@/config/manager';
import { lookupPriceBook } from '@/core/metrics/price-book';

export interface ModelPricing {
  inputPricePer1M: number;
  outputPricePer1M: number;
  /** True when neither the spec nor the price book had a number for this model. */
  isFallback: boolean;
}

const FALLBACK_INPUT_PRICE = 2.5;
const FALLBACK_OUTPUT_PRICE = 10;

/**
 * Read the configured fallback prices, tolerating an uninitialized config
 * (unit tests and scripts import the metrics modules without booting the app).
 */
function getFallbackPricing(): { input: number; output: number } {
  try {
    const metrics = getProxyConfig().metrics;
    return {
      input: metrics?.defaultInputPricePer1M ?? FALLBACK_INPUT_PRICE,
      output: metrics?.defaultOutputPricePer1M ?? FALLBACK_OUTPUT_PRICE,
    };
  } catch {
    return { input: FALLBACK_INPUT_PRICE, output: FALLBACK_OUTPUT_PRICE };
  }
}

/**
 * Resolve the effective per-1M-token prices for a model spec.
 *
 * Precedence: the spec's own prices, then the reference price book matched on
 * the model name, then the configured flat fallback.
 */
export function resolvePricing(modelSpec: IModelSpec | null | undefined): ModelPricing {
  const specInput = modelSpec?.inputPricePer1M;
  const specOutput = modelSpec?.outputPricePer1M;

  if (typeof specInput === 'number' && typeof specOutput === 'number') {
    return { inputPricePer1M: specInput, outputPricePer1M: specOutput, isFallback: false };
  }

  const book = modelSpec?.modelId ? lookupPriceBook(modelSpec.modelId) : null;
  if (book) {
    return {
      inputPricePer1M: typeof specInput === 'number' ? specInput : book.input,
      outputPricePer1M: typeof specOutput === 'number' ? specOutput : book.output,
      isFallback: false,
    };
  }

  const fallback = getFallbackPricing();
  return {
    inputPricePer1M: typeof specInput === 'number' ? specInput : fallback.input,
    outputPricePer1M: typeof specOutput === 'number' ? specOutput : fallback.output,
    isFallback: typeof specInput !== 'number' && typeof specOutput !== 'number',
  };
}

/**
 * Convert a token count into USD at the given per-1M-token rate.
 */
export function costOf(tokens: number, pricePer1M: number): number {
  if (!tokens || !pricePer1M) {
    return 0;
  }
  return (tokens * pricePer1M) / 1_000_000;
}
