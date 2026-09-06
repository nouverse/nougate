/**
 * What the provider declares about itself.
 *
 * Small assertions, and the reason they exist is not small. A provider is described to the operator
 * by exactly two things: its display name and its `accountFlow`. Get the flow wrong and the dashboard
 * renders a form for a credential the provider does not want — which is how this one shipped labelled
 * "ADD AN API KEY", with an `sk-…` placeholder, on a provider whose entire justification is
 * subscription-backed OAuth.
 *
 * That was not a cosmetic bug. A custom provider already reaches `api.anthropic.com` with an API key,
 * so a Claude provider that looks like an API-key form is a redundant one, and the right response to
 * it is to delete it.
 */

import { describe, expect, test } from 'bun:test';
import { ClaudeCodeProvider } from '@/providers/cc';
import { credentialKind } from '@/providers/cc/auth/credential';

describe('what the dashboard is told to render', () => {
  test('the credential this provider wants comes from a sign-in, not a paste', () => {
    const provider = new ClaudeCodeProvider();

    /**
     * `api-key` here is the regression, and it was not cosmetic: the same one-field form with the
     * wrong words is the whole of what an operator can see, and it made a subscription-OAuth provider
     * look like a redundant copy of a custom provider — which is the correct thing to delete.
     */
    expect(provider.accountFlow).toBe('oauth-redirect');
  });

  test('starting a sign-in returns a Claude authorize URL with a real PKCE challenge', async () => {
    const provider = new ClaudeCodeProvider();
    const started = (await provider.addAccount({})) as { redirectUrl: string; state: string };
    const url = new URL(started.redirectUrl);

    expect(url.origin + url.pathname).toBe('https://claude.ai/oauth/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // Antigravity sends a fixed `plain` challenge, which is not a challenge. Claude requires a real
    // one, and a verifier reused across sign-ins would defeat the point of PKCE entirely.
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // state must also be 43 chars (randomBytes(32) base64url), matching 9router.
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('state')).toBe(started.state);
    expect(url.searchParams.get('scope')).toContain('user:inference');
    // `code=true` is required by `claude.ai/oauth/authorize` — it is Claude-specific, not standard.
    expect(url.searchParams.get('code')).toBe('true');
  });

  test('two sign-ins never share a challenge or a state', async () => {
    const provider = new ClaudeCodeProvider();
    const first = new URL(((await provider.addAccount({})) as { redirectUrl: string }).redirectUrl);
    const second = new URL(((await provider.addAccount({})) as { redirectUrl: string }).redirectUrl);

    expect(second.searchParams.get('code_challenge')).not.toBe(first.searchParams.get('code_challenge'));
    expect(second.searchParams.get('state')).not.toBe(first.searchParams.get('state'));
  });

  test('the redirect_uri points to the gateway\'s own callback endpoint', async () => {
    const provider = new ClaudeCodeProvider();
    const started = (await provider.addAccount({})) as { redirectUrl: string };
    const authorizeUrl = new URL(started.redirectUrl);
    const redirectUri = new URL(authorizeUrl.searchParams.get('redirect_uri')!);

    // Must be exactly `/callback` — Claude Code CLI's client_id only allows this path.
    expect(redirectUri.pathname).toBe('/callback');
  });

  test('finishing a sign-in that was never started is refused, not crashed', async () => {
    // The shape a stale browser tab produces after a gateway restart.
    const provider = new ClaudeCodeProvider();
    expect(provider.addAccount({ code: 'abc' })).rejects.toThrow('no authorization is in progress');
  });

  test('the id and prefix operators type are stable', () => {
    // Models are addressed as `cc:<model>`, and that string ends up in config files and
    // agent packs. Renaming it silently breaks every one of them.
    const provider = new ClaudeCodeProvider();
    expect(provider.id).toBe('cc');
    expect(provider.displayName).toBe('Claude Code');
  });

  test('an API key is still accepted, it is just not what the form is for', () => {
    // Refusing one would be a rule with no benefit: the header logic has to tell the two apart
    // anyway, so supporting both costs a branch that already exists.
    expect(credentialKind('sk-ant-api03-abc')).toBe('api-key');
    expect(credentialKind('sk-ant-oat01-abc')).toBe('oauth');
  });

  test('every model it offers is addressable and priced', () => {
    const provider = new ClaudeCodeProvider();
    const registry = provider.getModelRegistry();
    const ids = registry.listModelIds();

    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const spec = registry.getSpec(id)!;
      // An unpriced model reports a cost of zero, which on a dashboard is indistinguishable from a
      // free one — the same failure the shared price book exists to avoid.
      expect(spec.inputPricePer1M).toBeGreaterThan(0);
      expect(spec.outputPricePer1M).toBeGreaterThan(0);
      expect(spec.maxOutputTokens).toBeGreaterThan(0);
    }
  });
});
