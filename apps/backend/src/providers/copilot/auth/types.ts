import type { IAccount } from '@/core/interfaces';

export interface CopilotAccount extends IAccount {
  readonly id: string; // e.g., githubUsername or email
  readonly providerId: 'copilot';
  personalToken: string; // ghu_xxx / gho_xxx / GitHub OAuth access_token
  githubUsername?: string;
  email?: string;

  // Session token (Layer 3) - cached in memory
  sessionToken?: string;
  sessionTokenExpiresAt?: number; // timestamp in ms

  // Rotation stats
  healthScore: number;
  modelScores?: Record<string, number>;
  lastUsed: number;
  tokenUsage?: number;
  consecutiveFailures?: number;
  cooldowns?: Record<string, number>;
  status: 'active' | 'cooldown' | 'invalid';
}

export interface GitHubDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

export interface CopilotSessionTokenResponse {
  token: string;
  expires_at: number; // Unix timestamp in seconds
}
