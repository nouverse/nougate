/**
 * Telling "this refresh token is finished" apart from "the network was having a moment".
 *
 * Codex OAuth uses the same RFC 6749 error codes as Claude, but the token endpoint is
 * auth.openai.com and the body is form-encoded. The classification logic is identical.
 */

const PERMANENT_MARKERS = [
  'invalid_grant',
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
  'invalid_request',
] as const;

export interface RefreshFailure {
  status: number;
  code: string;
  description: string;
  permanent: boolean;
}

const MAX_DESCRIPTION = 300;

export function classifyRefreshError(body: string, status = 0): RefreshFailure {
  let parsed: Record<string, any> | null = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    parsed = null;
  }

  const code = String(parsed?.error?.code ?? parsed?.error ?? parsed?.error_code ?? '');
  const description = String(
    parsed?.error_description ?? parsed?.error?.message ?? parsed?.message ?? body ?? '',
  ).slice(0, MAX_DESCRIPTION);

  const combined = `${code} ${description}`.toLowerCase();

  return {
    status,
    code,
    description,
    permanent: PERMANENT_MARKERS.some((marker) => combined.includes(marker)),
  };
}

export class TokenRefreshError extends Error {
  readonly failure: RefreshFailure;

  constructor(failure: RefreshFailure) {
    super(
      failure.code
        ? `token refresh failed (${failure.status} ${failure.code}): ${failure.description}`
        : `token refresh failed (${failure.status}): ${failure.description}`,
    );
    this.name = 'TokenRefreshError';
    this.failure = failure;
  }

  get permanent(): boolean {
    return this.failure.permanent;
  }
}

export function isPermanentRefreshFailure(error: unknown): boolean {
  return error instanceof TokenRefreshError && error.permanent;
}
