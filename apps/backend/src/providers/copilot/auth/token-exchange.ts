import { type CopilotAccount } from './types';

export interface GitHubUserProfile {
  login: string;
  email: string | null;
}

export async function exchangeSessionToken(personalToken: string): Promise<{ token: string; expiresAt: number }> {
  const response = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: {
      'Authorization': `Bearer ${personalToken}`,
      'User-Agent': 'GithubCopilot/1.250.0',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to exchange session token: Status ${response.status} - ${body}`);
  }

  const data = await response.json() as { token: string; expires_at: number };
  
  // expires_at is unix timestamp in seconds, convert to ms
  return {
    token: data.token,
    expiresAt: data.expires_at * 1000,
  };
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
