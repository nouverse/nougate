/**
 * Claude thinking signature validation (E/R form).
 *
 * Ported from CLIProxyAPI `internal/signature`. Validates that a thinking block's signature carries
 * the Claude marker byte (0x12), in one of two encodings:
 *
 *   - **E-form**: single-layer base64. `decoded[0] === 0x12`.
 *   - **R-form**: double-layer base64. Outer `decoded[0] === 'E'` (0x45), then inner `decoded[0] === 0x12`.
 *
 * A `#sig` cache prefix (e.g. `"...#sig<base64>"`) is stripped before validation.
 */

/** Maximum length of a raw signature string before it is rejected outright. */
const MAX_CLAUDE_SIGNATURE_LEN = 32 * 1024 * 1024;

/** The marker byte at the start of a decoded Claude signature. */
export const CLAUDE_SIGNATURE_MARKER = 0x12;

function stripCachePrefix(rawSignature: string): string {
  const sig = (rawSignature || '').trim();
  if (!sig) return '';
  const idx = sig.indexOf('#');
  return idx >= 0 ? sig.slice(idx + 1).trim() : sig;
}

/**
 * Full validation: base64-decode the signature and check the Claude marker byte.
 *
 * Returns `false` for anything that does not decode cleanly or lacks the marker — it never throws.
 */
export function isValidClaudeSignature(rawSignature: string): boolean {
  const sig = stripCachePrefix(rawSignature);
  if (!sig || sig.length > MAX_CLAUDE_SIGNATURE_LEN) return false;

  try {
    if (sig[0] === 'E') {
      const decoded = Buffer.from(sig, 'base64');
      return decoded.length > 0 && decoded[0] === CLAUDE_SIGNATURE_MARKER;
    }
    if (sig[0] === 'R') {
      const outer = Buffer.from(sig, 'base64');
      if (!outer.length || outer[0] !== 0x45) return false; // 'E'
      const inner = Buffer.from(outer.toString(), 'base64');
      return inner.length > 0 && inner[0] === CLAUDE_SIGNATURE_MARKER;
    }
    return false;
  } catch {
    return false;
  }
}
