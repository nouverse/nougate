import { existsSync, readFileSync, writeFileSync } from "fs";
import { randomBytes } from "node:crypto";
import { dataPath } from "@/core/paths";

// Overridable so tests (and unusual deployments) can keep the secret out of the
// shared data directory.
export function getSecretPath(): string {
  return process.env.SESSION_SECRET_FILE || dataPath(".session-secret");
}

const DEFAULT_SESSION_TTL_HOURS = 168;

let cachedSecret: string | null = null;

export function resetSessionSecretForTesting(): void {
  cachedSecret = null;
}

/**
 * How long an issued session cookie stays valid.
 */
export function getSessionTtlHours(): number {
  const raw = Number(process.env.SESSION_TTL_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SESSION_TTL_HOURS;
}

/**
 * Secret used to sign session cookies.
 *
 * SESSION_SECRET wins when set. Otherwise one is generated and persisted in the
 * data directory, so signing in never depends on remembering to invent a
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

  const secretPath = getSecretPath();

  try {
    if (existsSync(secretPath)) {
      const stored = readFileSync(secretPath, "utf8").trim();
      if (stored) {
        cachedSecret = stored;
        return cachedSecret;
      }
    }

    const generated = randomBytes(32).toString("base64");
    writeFileSync(secretPath, `${generated}\n`, { mode: 0o600 });
    cachedSecret = generated;
    console.log(`[Auth] Generated a session signing secret at ${secretPath}`);
    return cachedSecret;
  } catch (error) {
    console.error(
      `[Auth] Could not read or create ${secretPath}. Set SESSION_SECRET instead:`,
      error,
    );
    return null;
  }
}

export const SECRET_PATH = getSecretPath();
