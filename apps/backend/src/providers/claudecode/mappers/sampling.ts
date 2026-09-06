/**
 * Sampling parameters the newer Claude models refuse.
 *
 * `temperature`, `top_p` and `top_k` are rejected with a 400 by Opus 5, Opus 4.8, Sonnet 5 and
 * Fable 5.1 — not ignored, refused, so the request fails outright. Any client that tunes sampling
 * therefore cannot reach those models through this gateway at all, which is how an agentconfigured with
 * `temperature: 0.7` saw every Opus call fail while Sonnet 4.6 worked.
 *
 * Dropped rather than passed on, because the alternative is no answer. That does mean a caller's
 * `temperature: 0.2` stops being honoured — but it was never honoured; it was a 400. The one value
 * these models do accept is `temperature: 1`, which is Anthropic's own default, so removing it
 * changes nothing. Removing all three unconditionally keeps one rule instead of three exceptions.
 */

import { deprecatesSamplingParams } from '../config/model-specs';

const SAMPLING_KEYS = ['temperature', 'top_p', 'top_k'] as const;

/**
 * Strip sampling parameters when the target model refuses them.
 *
 * Returns the original object when there is nothing to remove, so the common case allocates nothing
 * and a caller can compare by identity to tell whether it acted.
 */
export function dropDeprecatedSampling(body: unknown, upstreamModelId: string): unknown {
  if (!deprecatesSamplingParams(upstreamModelId)) return body;
  if (!body || typeof body !== 'object') return body;

  const source = body as Record<string, unknown>;
  const present = SAMPLING_KEYS.filter((key) => source[key] !== undefined);
  if (present.length === 0) return body;

  console.warn(
    `[claudecode] ${upstreamModelId} does not accept ${present.join(', ')}; dropped rather than failing the request`,
  );

  const stripped = { ...source };
  for (const key of present) delete stripped[key];
  return stripped;
}
