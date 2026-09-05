/**
 * Getting a fresh OAuth access token, the supported way.
 *
 * Anthropic's own CLI mints and refreshes these — `ant auth print-credentials --access-token` prints
 * a current one and renews it first if it has expired. That is the whole mechanism: nougate does not
 * implement an OAuth client, hold a client id, or talk to an authorization server. It asks the tool
 * that already owns the session.
 *
 * Two consequences worth stating plainly, because both are the operator's to accept:
 *
 *   - The command runs on the **gateway host**, so that host needs the CLI installed and logged in.
 *   - It is a shell command from a config file. Nothing an inbound request can influence reaches it,
 *     and it is empty until an operator writes one — but it is still the gateway executing a string,
 *     so it is opt-in rather than a default with a sensible-looking value already in it.
 */

import { getClaudeCodeConfig } from '../config/provider-config';

/** Long enough for a browserless token mint, short enough not to hold a request open. */
const REFRESH_TIMEOUT_MS = 30_000;

export interface RefreshResult {
  token?: string;
  /** Why it did not produce one, for the log and the account's invalid reason. */
  error?: string;
}

export async function refreshAccessToken(): Promise<RefreshResult> {
  const command = getClaudeCodeConfig().refreshCommand.trim();
  if (!command) return { error: 'no refresh command configured' };

  try {
    const proc = Bun.spawn(['sh', '-lc', command], {
      stdout: 'pipe',
      stderr: 'pipe',
      // Inherit nothing that is not already in this process: the CLI needs HOME to find its profile,
      // and giving it the full environment would hand it every other provider's secrets too.
      env: {
        HOME: process.env.HOME ?? '',
        PATH: process.env.PATH ?? '',
        ...(process.env.ANTHROPIC_CONFIG_DIR
          ? { ANTHROPIC_CONFIG_DIR: process.env.ANTHROPIC_CONFIG_DIR }
          : {}),
      },
    });

    const timeout = setTimeout(() => proc.kill(), REFRESH_TIMEOUT_MS);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timeout);

    if (code !== 0) {
      // stderr, truncated: a CLI that failed to authenticate can print a lot, and the whole of it in
      // a log line is both useless and a place a token could end up by accident.
      return { error: `refresh command exited ${code}: ${stderr.trim().slice(0, 200)}` };
    }

    // The last non-empty line, not the whole output: a CLI is free to print a notice above the value,
    // and concatenating that into the credential produces a 401 nobody can read.
    const token = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);

    if (!token) return { error: 'refresh command printed nothing' };
    return { token };
  } catch (error) {
    return { error: `refresh command failed: ${String(error).slice(0, 200)}` };
  }
}
