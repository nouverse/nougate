/**
 * The OAuth redirect URI of a native-client provider must not follow `BASE_URL`.
 *
 * Claude Code and Codex both authenticate with a **CLI** client id. Those accept a loopback redirect
 * — `http://localhost:{port}/...`, RFC 8252 — and refuse anything else, so the URI is a property of
 * the client id, not of where this gateway happens to be deployed.
 *
 * Claude Code's was built from `BASE_URL`, which is loopback on a laptop and a real domain in
 * production. It therefore passed every local test and failed the first deployment: the authorize
 * request went out with `https://<host>/callback` and was refused before a consent screen appeared.
 * Correct by coincidence is what this file exists to stop.
 */

import { afterEach, describe, expect, test } from 'bun:test';

const ORIGINAL = { BASE_URL: process.env.BASE_URL, PORT: process.env.PORT };

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * Read the redirect URI the provider would send, by starting the flow and parsing the URL it hands
 * back. Going through `addAccount` rather than the private helper keeps this honest about what an
 * operator actually triggers.
 */
async function redirectUriFor(providerModule: any): Promise<string> {
  const provider = new providerModule();
  const started = (await provider.addAccount({})) as { redirectUrl: string };
  return new URL(started.redirectUrl).searchParams.get('redirect_uri') ?? '';
}

describe('OAuth redirect URIs stay on loopback', () => {
  test('Claude Code ignores a deployed BASE_URL', async () => {
    process.env.BASE_URL = 'https://nougate.nouverse.tech';
    process.env.PORT = '3000';

    const { ClaudeCodeProvider } = await import('@/providers/claudecode');
    const uri = await redirectUriFor(ClaudeCodeProvider);

    expect(uri).toBe('http://localhost:3000/callback');
    expect(uri).not.toContain('nouverse.tech');
  });

  test('Claude Code follows the port it actually listens on', async () => {
    // The port is free — only the loopback host and the `/callback` path are fixed — so a gateway on
    // 4000 must not hand out a redirect pointing at 3000.
    process.env.BASE_URL = 'https://nougate.nouverse.tech';
    process.env.PORT = '4000';

    const { ClaudeCodeProvider } = await import('@/providers/claudecode');
    expect(await redirectUriFor(ClaudeCodeProvider)).toBe('http://localhost:4000/callback');
  });

  test('Codex ignores BASE_URL and pins its own port', async () => {
    // OpenAI's client id is bound to 1455 specifically, so this one is a constant rather than a
    // reading of PORT — a gateway on 4000 still redirects to 1455.
    process.env.BASE_URL = 'https://nougate.nouverse.tech';
    process.env.PORT = '4000';

    const { CodexProvider } = await import('@/providers/codex');
    const uri = await redirectUriFor(CodexProvider);

    expect(uri).toBe('http://localhost:1455/auth/callback');
    expect(uri).not.toContain('nouverse.tech');
  });
});
