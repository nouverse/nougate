/**
 * The headers one request to the Messages API carries, beyond authentication.
 *
 * `auth/credential.ts` decides which header the *credential* belongs on. This decides everything
 * else, and in practice that means one header: `anthropic-beta`.
 *
 * ## Why the beta list matters more than it looks
 *
 * These are feature gates, not version pinning. A capability that is absent from this header is a
 * capability the upstream will not honour even when the request body asks for it — and it does not
 * error, it simply behaves like the feature does not exist. That failure mode is why the list lives
 * here as data rather than being spelled inline at the call site:
 *
 *   - `interleaved-thinking-*` — thinking blocks between tool calls. Without it a client asking for
 *     interleaved thinking gets ordinary thinking and no explanation.
 *   - `context-management-*` — server-side context editing, which a long agentic run depends on.
 *   - `prompt-caching-scope-*` — the scoping this gateway's own cache-breakpoint work assumes.
 *   - `token-efficient-tools-*`, `advanced-tool-use-*` — tool-call encoding and behaviour.
 *   - `effort-*`, `structured-outputs-*`, `fast-mode-*`, `redact-thinking-*` — request parameters
 *     that are accepted and ignored without the matching gate.
 *   - `oauth-2025-04-20` — required on `/v1/messages` for an OAuth token, and the single most
 *     confusing omission: without it a perfectly valid token 401s.
 *
 * ## Why it is configurable
 *
 * Anthropic adds and retires these on its own schedule, and a gate that has graduated to general
 * availability is sometimes rejected as unknown. An operator who needs to add or drop one should not
 * be waiting on a release of this gateway, so the default list below is a default and nothing more —
 * `betaFeatures` in the provider config replaces it wholesale.
 */

import { ANTHROPIC_VERSION, authHeaders, credentialKind } from '../auth/credential';
import { getClaudeCodeConfig } from '../config/provider-config';
import { CLAUDE_CLI_SPOOF_HEADERS, selectAnthropicBeta } from './spoof-headers';

/**
 * The gates this provider asks for when the operator has not said otherwise.
 *
 * This is the reference implementation's list, in its order — it is the combination known to work
 * against a live OAuth credential, so it is the one to start from rather than a curated subset.
 * They drift; when you change one, put the date you checked in the commit message.
 */
export const DEFAULT_BETA_FEATURES = [
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'advanced-tool-use-2025-11-20',
  'effort-2025-11-24',
  'structured-outputs-2025-12-15',
  'fast-mode-2026-02-01',
  'redact-thinking-2026-02-12',
  'token-efficient-tools-2026-03-28',
] as const;

/**
 * Every header for one request, credential included.
 *
 * `anthropic-beta` is assembled rather than concatenated blindly: `authHeaders` already puts
 * `oauth-2025-04-20` there for an OAuth credential, and sending a gate twice is a 400. A `Set`
 * preserves first-seen order while making the duplicate impossible.
 */
export function buildRequestHeaders(credential: string, model?: string): Record<string, string> {
  const auth = authHeaders(credential);
  const isOAuth = credentialKind(credential) === 'oauth';
  const configured = getClaudeCodeConfig().betaFeatures;

  // For OAuth credentials, use the model-aware beta builder from the spoof-headers module.
  // For API keys, fall back to the static default list (or operator override).
  const features = configured.length > 0
    ? configured
    : isOAuth && model
      ? selectAnthropicBeta(model).split(',')
      : [...DEFAULT_BETA_FEATURES];

  const betas = new Set<string>();
  // Whatever the credential already required comes first — `oauth-2025-04-20` is not optional and
  // must not be lost to an operator's replacement list.
  for (const existing of (auth['anthropic-beta'] ?? '').split(',')) {
    const value = existing.trim();
    if (value) betas.add(value);
  }
  for (const feature of features) {
    const value = feature.trim();
    if (value) betas.add(value);
  }

  const base: Record<string, string> = {
    'content-type': 'application/json',
    ...auth,
    'anthropic-version': ANTHROPIC_VERSION,
    ...(betas.size > 0 ? { 'anthropic-beta': [...betas].join(',') } : {}),
  };

  // OAuth credentials get the full Claude CLI spoof headers (User-Agent, X-Stainless-*, etc.).
  // API key users should not impersonate the CLI — they are already paying per token.
  if (isOAuth) {
    return { ...CLAUDE_CLI_SPOOF_HEADERS, ...base };
  }

  return base;
}
