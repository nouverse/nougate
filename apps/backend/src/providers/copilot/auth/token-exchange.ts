import { type CopilotAccount } from './types';

export interface GitHubUserProfile {
  login: string;
  email: string | null;
}

/**
 * Error thrown when the GitHub session-token exchange fails.
 * `status` is the HTTP status (undefined for network-level failures).
 * `transient` marks failures that are worth retrying (network errors, 5xx,
 * 429) as opposed to hard auth failures (401/403) that require a re-login.
 */
export class TokenExchangeError extends Error {
  readonly status?: number;
  readonly transient: boolean;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'TokenExchangeError';
    this.status = status;
    // No status => network/DNS/timeout error. 5xx (e.g. GitHub's 502 "Unicorn"
    // page) and 429 are server-side hiccups that usually clear on retry.
    this.transient = status === undefined || status >= 500 || status === 429;
  }
}

async function backoff(attempt: number): Promise<void> {
  const base = 500 * Math.pow(2, attempt); // 500ms, 1s, 2s, ...
  const jitter = Math.random() * 250;
  await new Promise((resolve) => setTimeout(resolve, base + jitter));
}

export async function exchangeSessionToken(personalToken: string): Promise<{ token: string; expiresAt: number }> {
  const maxRetries = 3;
  let lastError: TokenExchangeError | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let response: Response;
    try {
      response = await fetch('https://api.github.com/copilot_internal/v2/token', {
        headers: {
          'Authorization': `Bearer ${personalToken}`,
          'User-Agent': 'GithubCopilot/1.250.0',
        },
      });
    } catch (e: any) {
      // Network-level failure: always transient, retry.
      lastError = new TokenExchangeError(`Network error exchanging session token: ${e?.message || e}`);
      if (attempt < maxRetries - 1) await backoff(attempt);
      continue;
    }

    if (response.ok) {
      const data = await response.json() as { token: string; expires_at: number };
      // expires_at is unix timestamp in seconds, convert to ms
      return {
        token: data.token,
        expiresAt: data.expires_at * 1000,
      };
    }

    const body = await response.text();
    lastError = new TokenExchangeError(
      `Failed to exchange session token: Status ${response.status} - ${body}`,
      response.status,
    );

    // Fail fast on hard auth failures; only retry transient server-side errors.
    if (!lastError.transient) break;
    if (attempt < maxRetries - 1) await backoff(attempt);
  }

  throw lastError ?? new TokenExchangeError('Failed to exchange session token: unknown error');
}

export async function getGitHubProfile(personalToken: string): Promise<GitHubUserProfile> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      'Authorization': `Bearer ${personalToken}`,
      'User-Agent': 'GithubCopilot/1.250.0',
      'Accept': 'application/vnd.github+json',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch GitHub profile: Status ${response.status} - ${body}`);
  }

  const data = await response.json() as { login: string; email: string | null };
  return {
    login: data.login,
    email: data.email,
  };
}

export async function ensureSessionToken(account: CopilotAccount): Promise<string> {
  const now = Date.now();
  // 60 seconds buffer before token expiry
  const bufferMs = 60000;
  
  if (
    account.sessionToken &&
    account.sessionTokenExpiresAt &&
    account.sessionTokenExpiresAt > now + bufferMs
  ) {
    return account.sessionToken;
  }

  const result = await exchangeSessionToken(account.personalToken);
  account.sessionToken = result.token;
  account.sessionTokenExpiresAt = result.expiresAt;
  return result.token;
}
