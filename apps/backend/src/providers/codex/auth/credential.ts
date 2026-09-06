/**
 * Decode the ChatGPT Account ID from a Codex id_token JWT.
 *
 * The claim lives at `https://api.openai.com/auth.chatgpt_account_id` in the JWT payload.
 * Required for the `ChatGPT-Account-ID` header — without it, multi-account setups cross-bind.
 */
export function decodeAccountId(idToken: string | undefined | null): string | null {
  try {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (b64.length % 4)) % 4;
    const payload = JSON.parse(Buffer.from(b64 + '='.repeat(pad), 'base64').toString('utf8'));
    return payload?.['https://api.openai.com/auth']?.chatgpt_account_id || null;
  } catch {
    return null;
  }
}

/**
 * A short, non-reversible fingerprint for logs and the dashboard list.
 * Never the token itself.
 */
export function credentialHint(accessToken: string): string {
  const value = accessToken.trim();
  return value.length <= 8 ? '…' : `${value.slice(0, 4)}…${value.slice(-4)}`;
}
