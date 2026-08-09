import type { IModelSpec } from '@/core/interfaces';
import { getProxyConfig } from '@/config/manager';
import { lookupPriceBook } from '@/core/metrics/price-book';

export interface ModelPricing {
  inputPricePer1M: number;
  outputPricePer1M: number;
  /**
   * False when no rate is known for this model, in which case the prices are 0.
   *
   * Cost is then reported as $0 and flagged, rather than invented from a blanket
   * default — a made-up rate is indistinguishable from a real one on a chart,
   * while a visible "unpriced" marker tells you exactly which models still need
   * a number.
   */
  isPriced: boolean;
}

const UNPRICED: ModelPricing = {
  inputPricePer1M: 0,
  outputPricePer1M: 0,
  isPriced: false,
};

/**
 * Optional blanket rate for models nothing else can price.
 *
 * Off by default (0 = no fallback). Set `metrics.defaultInputPricePer1M` /
 * `defaultOutputPricePer1M` to opt into an estimate instead of $0.
 */
function getConfiguredFallback(): { input: number; output: number } | null {
  try {
    const metrics = getProxyConfig().metrics;
    const input = metrics?.defaultInputPricePer1M ?? 0;
    const output = metrics?.defaultOutputPricePer1M ?? 0;
    return input > 0 || output > 0 ? { input, output } : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the effective per-1M-token prices for a model spec.
 *
 * Precedence: the spec's own prices (set per model in the dashboard), then the
 * reference price book matched on the model name, then the optional configured
 * blanket rate. If none apply, the model is reported as unpriced.
 */
export function resolvePricing(modelSpec: IModelSpec | null | undefined): ModelPricing {
  const specInput = modelSpec?.inputPricePer1M;
  const specOutput = modelSpec?.outputPricePer1M;

  // An explicit 0 is a real answer ("this model is free"), so test for the
  // presence of a number rather than for truthiness.
  if (typeof specInput === 'number' && typeof specOutput === 'number') {
    return { inputPricePer1M: specInput, outputPricePer1M: specOutput, isPriced: true };
  }

  const book = modelSpec?.modelId ? lookupPriceBook(modelSpec.modelId) : null;
  if (book) {
    return {
      inputPricePer1M: typeof specInput === 'number' ? specInput : book.input,
      outputPricePer1M: typeof specOutput === 'number' ? specOutput : book.output,
      isPriced: true,
    };
  }

  const fallback = getConfiguredFallback();
  if (fallback) {
    return {
      inputPricePer1M: typeof specInput === 'number' ? specInput : fallback.input,
      outputPricePer1M: typeof specOutput === 'number' ? specOutput : fallback.output,
      isPriced: true,
    };
  }

  // Half-configured models (only one side set) still count as priced.
  if (typeof specInput === 'number' || typeof specOutput === 'number') {
    return {
      inputPricePer1M: specInput ?? 0,
      outputPricePer1M: specOutput ?? 0,
      isPriced: true,
    };
  }

  return { ...UNPRICED };
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
