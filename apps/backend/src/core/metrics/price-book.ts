/**
 * Reference upstream list prices, in USD per 1M tokens.
 *
 * These exist so cost tracking produces a meaningful number for models whose
 * spec carries no explicit pricing — including models reached through
 * `bypassModelValidation`. They are *estimates* of what the same traffic would
 * cost at the upstream vendor's published rate, not what Nougate is billed:
 * Copilot and Antigravity are subscription-based, so the dashboard figure is a
 * "value routed through the gateway" number.
 *
 * Any model can override this by setting `inputPricePer1M` / `outputPricePer1M`
 * on its spec (or, for custom providers, in the dashboard's model editor).
 */
interface PriceEntry {
  /** Matched against the lowercased model ID, first match wins. */
  pattern: RegExp;
  input: number;
  output: number;
}

const PRICE_BOOK: PriceEntry[] = [
  // Anthropic family
  { pattern: /claude.*opus/, input: 5, output: 25 },
  { pattern: /claude.*sonnet/, input: 3, output: 15 },
  { pattern: /claude.*haiku/, input: 1, output: 5 },
  // Fable 5 and 5.1 at Anthropic's published rate, checked 2026-06-24.
  { pattern: /claude.*fable/, input: 10, output: 50 },

  // Google Gemini family
  { pattern: /gemini.*flash.*lite/, input: 0.1, output: 0.4 },
  { pattern: /gemini.*flash.*image/, input: 0.3, output: 2.5 },
  { pattern: /gemini.*flash/, input: 0.3, output: 2.5 },
  { pattern: /gemini.*pro/, input: 1.25, output: 10 },

  // OpenAI family
  { pattern: /gpt-5.*mini/, input: 0.25, output: 2 },
  { pattern: /gpt-5/, input: 1.25, output: 10 },
  { pattern: /gpt-4\.1.*mini/, input: 0.4, output: 1.6 },
  { pattern: /gpt-4\.1/, input: 2, output: 8 },
  { pattern: /gpt-4o.*mini/, input: 0.15, output: 0.6 },
  { pattern: /gpt-4o/, input: 2.5, output: 10 },
  { pattern: /^o3/, input: 2, output: 8 },

  // Common OSS / third-party families seen behind custom providers
  { pattern: /deepseek.*reasoner|deepseek-r1/, input: 0.55, output: 2.19 },
  { pattern: /deepseek/, input: 0.27, output: 1.1 },
  { pattern: /qwen/, input: 0.4, output: 1.2 },
  { pattern: /llama/, input: 0.2, output: 0.6 },
  { pattern: /grok/, input: 3, output: 15 },
];

/**
 * Look up reference pricing for a model ID, or null when nothing matches.
 */
export function lookupPriceBook(modelId: string): { input: number; output: number } | null {
  const normalized = modelId.trim().toLowerCase();

  for (const entry of PRICE_BOOK) {
    if (entry.pattern.test(normalized)) {
      return { input: entry.input, output: entry.output };
    }
  }

  return null;
}
