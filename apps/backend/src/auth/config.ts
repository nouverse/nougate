import { join, dirname } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { randomBytes } from "node:crypto";
import { type AuthConfig } from "@/auth/types";
import { dataPath, projectPath } from "@/core/paths";

/**
 * Locations checked for the allowlist, in order. Covers the Docker volume, the
 * host-side data directory that volume maps to, and a plain repo-root file — so
 * the guard finds it regardless of how the gateway was launched.
 *
 * Anchored to the project root rather than the working directory: launching
 * from `apps/backend` used to miss the allowlist entirely, silently leaving the
 * dashboard open.
 */
const AUTH_PATH_CANDIDATES = [
  "/app/data/auth.json",
  dataPath("auth.json"),
  projectPath("auth.json"),
];

/**
 * Resolve where the allowlist lives: an explicit override, else the first
 * candidate that exists, else the preferred default for this environment.
 */
function resolveAuthPath(): string {
  if (process.env.AUTH_FILE) {
    return process.env.AUTH_FILE;
  }
  return (
    AUTH_PATH_CANDIDATES.find((candidate) => existsSync(candidate)) ||
    (existsSync("/app/data") ? AUTH_PATH_CANDIDATES[0] : AUTH_PATH_CANDIDATES[1])
  );
}

const AUTH_PATH = resolveAuthPath();
const SECRET_PATH = join(dirname(AUTH_PATH), ".session-secret");

const DEFAULT_AUTH_CONFIG: AuthConfig = {
  enabled: true,
  allowedEmails: [],
  sessionTtlHours: 168,
};

let lastParseError = "";

/**
 * Read and normalize the auth file, tolerating a missing or malformed file.
 *
 * The file is read on every call rather than cached: an mtime cache cannot
 * distinguish two edits landing in the same millisecond, and this only runs on
 * dashboard requests, where one small synchronous read is irrelevant.
 */
function readAuthFile(): AuthConfig {
  if (!existsSync(AUTH_PATH)) {
    return { ...DEFAULT_AUTH_CONFIG, enabled: false };
  }

  try {
    const parsed = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
    lastParseError = "";
    return {
      enabled: parsed.enabled !== false,
      allowedEmails: Array.isArray(parsed.allowedEmails)
        ? parsed.allowedEmails.filter((entry: unknown) => typeof entry === "string")
        : [],
      hostedDomain: typeof parsed.hostedDomain === "string" ? parsed.hostedDomain : undefined,
      sessionTtlHours:
        typeof parsed.sessionTtlHours === "number" && parsed.sessionTtlHours > 0
          ? parsed.sessionTtlHours
          : DEFAULT_AUTH_CONFIG.sessionTtlHours,
    };
  } catch (error: any) {
    // Fail closed: an unreadable allowlist keeps the guard on with nobody on it,
    // so a corrupt file denies everyone rather than admitting everyone. Log once
    // per distinct failure so a broken file does not flood the console.
    const message = String(error?.message || error);
    if (message !== lastParseError) {
      lastParseError = message;
      console.error(`[Auth] Failed to parse ${AUTH_PATH}, denying all access: ${message}`);
    }
    return { ...DEFAULT_AUTH_CONFIG, enabled: true, allowedEmails: [] };
  }
}

/**
 * Return the current auth config, reflecting any edit already made on disk.
 */
export function getAuthConfig(): AuthConfig {
  return readAuthFile();
}

/**
 * Print a banner that cannot be mistaken for a routine startup line.
 */
function warnLoudly(title: string, lines: string[]): void {
  const border = "─".repeat(74);
  console.warn(`\n┌${border}┐`);
  console.warn(`  ⚠  ${title}`);
  console.warn(`├${border}┤`);
  for (const line of lines) {
    console.warn(`  ${line}`);
  }
  console.warn(`└${border}┘\n`);
}

/**
 * Report the auth posture once during startup.
 *
 * A half-finished setup leaves the dashboard open, which is easy to miss in a
 * normal log line — so anything that looks like an intent to enable auth is
 * reported as a banner instead.
 */
export function loadAuthConfig(): AuthConfig {
  const config = getAuthConfig();

  if (!isAuthEnabled()) {
    warnLoudly("DASHBOARD IS OPEN — no authentication", [
      existsSync(AUTH_PATH)
        ? `"enabled" is false in ${AUTH_PATH}.`
        : `No allowlist at ${AUTH_PATH}. Copy auth.example.json there to turn it on.`,
      "",
      "Anyone who can reach this port has full admin access.",
    ]);
    return config;
  }

  if (config.allowedEmails.length === 0) {
    warnLoudly("DASHBOARD LOCKED — the allowlist is empty", [
      `Nobody can sign in. Add at least one address to ${AUTH_PATH},`,
      'or set "enabled": false there to reopen the dashboard.',
    ]);
    return config;
  }

  if (!getGoogleCredentials()) {
    warnLoudly("DASHBOARD LOCKED — the login flow cannot run", [
      "The dashboard is closed, but GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET",
      "are not set, so nobody can complete sign-in. Set them in the",
      'environment, or set "enabled": false to reopen the dashboard.',
    ]);
    return config;
  }

  console.log(
    `[Auth] Dashboard PROTECTED — ${config.allowedEmails.length} allowed email(s) from ${AUTH_PATH}`,
  );
  return config;
}

/**
 * Google credentials required to run the login flow.
 */
export function getGoogleCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return null;
  }
  return { clientId, clientSecret };
}

let cachedSecret: string | null = null;

/**
 * Secret used to sign session cookies.
 *
 * SESSION_SECRET wins when set. Otherwise one is generated and persisted next to
 * the allowlist, so enabling auth never depends on remembering to invent a
 * secret. It lives on the same volume as the rest of the state, so sessions
 * survive restarts.
 */
export function getSessionSecret(): string | null {
  if (process.env.SESSION_SECRET) {
    return process.env.SESSION_SECRET;
  }

  if (cachedSecret) {
    return cachedSecret;
  }

  try {
    if (existsSync(SECRET_PATH)) {
      const stored = readFileSync(SECRET_PATH, "utf8").trim();
      if (stored) {
        cachedSecret = stored;
        return cachedSecret;
      }
    }

    const generated = randomBytes(32).toString("base64");
    writeFileSync(SECRET_PATH, `${generated}\n`, { mode: 0o600 });
    cachedSecret = generated;
    console.log(`[Auth] Generated a session signing secret at ${SECRET_PATH}`);
    return cachedSecret;
  } catch (error) {
    console.error(
      `[Auth] Could not read or create ${SECRET_PATH}. Set SESSION_SECRET instead:`,
      error,
    );
    return null;
  }
}

/**
 * One switch, one field: `enabled` in auth.json.
 *
 * Nothing else can reopen the dashboard — not missing Google credentials, not an
 * empty allowlist, not a corrupt file. Every one of those keeps the guard closed
 * and is reported by the startup banner. The only way to open the dashboard is
 * to say so explicitly, so a mistake can never silently unlock it.
 */
export function isAuthEnabled(): boolean {
  return getAuthConfig().enabled;
}

/**
 * Check an email against the allowlist, ignoring case and surrounding spaces.
 */
export function isEmailAllowed(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return getAuthConfig().allowedEmails.some(
    (entry) => entry.trim().toLowerCase() === normalized,
  );
}

export { AUTH_PATH };
