/**
 * Dashboard access control settings, persisted outside of config.json so the
 * admin API can never rewrite the list of people allowed to log in.
 */
export interface AuthConfig {
  /** Master switch. Auth also stays off when the Google credentials are absent. */
  enabled: boolean;
  /** Google accounts allowed to reach the dashboard, compared case-insensitively. */
  allowedEmails: string[];
  /** Optional Google Workspace domain hint passed as `hd` on the consent screen. */
  hostedDomain?: string;
  /** Lifetime of an issued session cookie. */
  sessionTtlHours: number;
}

/** The identity carried inside a signed session cookie. */
export interface SessionPayload {
  email: string;
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds. */
  exp: number;
}
