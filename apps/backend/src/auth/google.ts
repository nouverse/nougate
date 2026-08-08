import { getAuthConfig, getGoogleCredentials } from "@/auth/config";

const AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URI = "https://oauth2.googleapis.com/token";

interface GoogleTokenResponse {
  access_token?: string;
  id_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

/**
 * The redirect URI registered in the Google Cloud console.
 */
export function buildRedirectUri(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/api/auth/callback`;
}

/**
 * Build the Google consent URL for the dashboard login flow.
 */
export function buildAuthUrl(state: string, baseUrl: string): string {
  const credentials = getGoogleCredentials();
  if (!credentials) {
    throw new Error("Google OAuth credentials are not configured");
  }

  const params = new URLSearchParams({
    client_id: credentials.clientId,
    redirect_uri: buildRedirectUri(baseUrl),
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });

  const hostedDomain = getAuthConfig().hostedDomain;
  if (hostedDomain) {
    params.set("hd", hostedDomain);
  }

  return `${AUTH_URI}?${params.toString()}`;
}

/**
 * Exchange an authorization code for Google's token response.
 */
export async function exchangeCode(code: string, baseUrl: string): Promise<GoogleTokenResponse> {
  const credentials = getGoogleCredentials();
  if (!credentials) {
    throw new Error("Google OAuth credentials are not configured");
  }

  const params = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    redirect_uri: buildRedirectUri(baseUrl),
    grant_type: "authorization_code",
    code,
  });

  const res = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  const body = (await res.json()) as GoogleTokenResponse;
  if (!res.ok || body.error) {
    throw new Error(body.error_description || body.error || `Token exchange failed (${res.status})`);
  }
  return body;
}

/**
 * Read the identity out of an ID token.
 *
 * The token arrives over TLS on a direct server-to-server call to Google's token
 * endpoint, which the OIDC spec treats as sufficient to skip signature
 * verification — there is no untrusted hop that could have swapped it.
 */
export function readIdentity(idToken: string): GoogleIdentity {
  const segments = idToken.split(".");
  if (segments.length < 2) {
    throw new Error("Malformed ID token");
  }

  const claims = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
  if (!claims.email) {
    throw new Error("ID token did not contain an email");
  }

  return {
    email: String(claims.email),
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
    name: claims.name ? String(claims.name) : undefined,
    picture: claims.picture ? String(claims.picture) : undefined,
  };
}
