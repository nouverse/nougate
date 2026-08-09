/** The identity carried inside a signed session cookie. */
export interface SessionPayload {
  /** User ID. */
  sub: string;
  username: string;
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds. */
  exp: number;
}
