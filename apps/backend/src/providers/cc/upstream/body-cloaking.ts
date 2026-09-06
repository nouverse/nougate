/**
 * Body-level Claude cloaking — billing header injection and fake metadata.
 *
 * These transformations make the request body look like it came from a real Claude Code session:
 *
 *   1. **Billing header** — injected as `system[0]`, a text block containing the
 *      `x-anthropic-billing-header` string the upstream expects.
 *   2. **Fake user ID** — injected into `metadata.user_id`, a JSON blob with `device_id`,
 *      `account_uuid`, and `session_id` that fingerprints like a real device.
 *
 * Only applied for OAuth credentials — API key users are already paying per token.
 */

import { createHash, randomBytes, randomUUID } from 'crypto';
import { CLAUDE_CLI_VERSION, CC_ENTRYPOINT } from '../config/cloaking';

// ---------------------------------------------------------------------------
// Billing header
// ---------------------------------------------------------------------------

/**
 * Generate the billing header string expected from current Claude Code clients.
 *
 * Format: `x-anthropic-billing-header: cc_version=<ver>.<3-char-build>; cc_entrypoint=sdk-cli; cch=<5-char-sha256>;`
 */
export function generateBillingHeader(payload: unknown): string {
  const content = JSON.stringify(payload);
  const cch = createHash('sha256').update(content).digest('hex').slice(0, 5);
  const buildHash = randomBytes(2).toString('hex').slice(0, 3);
  return `x-anthropic-billing-header: cc_version=${CLAUDE_CLI_VERSION}.${buildHash}; cc_entrypoint=${CC_ENTRYPOINT}; cch=${cch};`;
}

// ---------------------------------------------------------------------------
// Fake user ID
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic UUID-v4-shaped string from a seed.
 *
 * Stable per seed — the same API key always produces the same UUID, which is what makes the
 * device fingerprint consistent across requests.
 */
export function deriveUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Generate a fake user ID in the Claude Code JSON format.
 *
 * ```json
 * {"device_id":"<64hex>","account_uuid":"<uuid>","session_id":"<uuid>"}
 * ```
 *
 * `device_id` and `account_uuid` are derived from the API key (stable per account).
 * `session_id` is per-conversation, aligned with `X-Claude-Code-Session-Id`.
 */
export function generateFakeUserID(sessionId: string | undefined, apiKey: string | undefined): string {
  const deviceId = apiKey
    ? createHash('sha256').update(`device:${apiKey}`).digest('hex')
    : randomBytes(32).toString('hex');
  const accountUuid = apiKey ? deriveUuid(`account:${apiKey}`) : randomUUID();
  const sessionUuid = sessionId || randomUUID();
  return `{"device_id":"${deviceId}","account_uuid":"${accountUuid}","session_id":"${sessionUuid}"}`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Apply Claude cloaking to a request body.
 *
 * 1. Injects the billing header as `system[0]` (preserving existing system blocks).
 * 2. Injects a fake `metadata.user_id` (skipped if one is already present).
 *
 * @param body     - The Anthropic Messages API request body.
 * @param isOAuth  - Whether the credential is OAuth. Cloaking is skipped for API keys.
 * @param sessionId - Session ID to align with `X-Claude-Code-Session-Id` header.
 * @param credential - The credential string, used to derive stable device fingerprints.
 */
export function applyCloaking(
  body: any,
  isOAuth: boolean,
  sessionId?: string,
  credential?: string,
): any {
  if (!isOAuth) return body;

  const result = { ...body };

  // --- Billing header as system[0] ---
  const billingText = generateBillingHeader(body);
  const billingBlock = { type: 'text', text: billingText };

  if (Array.isArray(result.system)) {
    // Skip if already injected (idempotency guard).
    if (!result.system[0]?.text?.startsWith('x-anthropic-billing-header:')) {
      result.system = [billingBlock, ...result.system];
    }
  } else if (typeof result.system === 'string') {
    result.system = [billingBlock, { type: 'text', text: result.system }];
  } else {
    result.system = [billingBlock];
  }

  // --- Fake user ID in metadata ---
  if (!result.metadata?.user_id) {
    result.metadata = { ...result.metadata, user_id: generateFakeUserID(sessionId, credential) };
  }

  return result;
}
