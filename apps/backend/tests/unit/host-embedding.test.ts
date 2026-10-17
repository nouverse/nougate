/**
 * Running inside a host that shows this dashboard as one of its own pages (`core/host.ts`).
 *
 * Nouride's router editions do: the gateway answers in the daemon's process, and its dashboard is the
 * daemon's "LLM Gateway" page under `/llm-gateway/`. What has to hold:
 *
 * - The host vouches per request **object**. A request it did not hand over — anything that reached
 *   this port from the network — gets the gateway's own sign-in, whatever it carries.
 * - A vouched request is signed in as the host's person, with no password of ours to change.
 * - The dashboard is addressed under the host's prefix: its bundle, its redirects, its API calls.
 * - The host can mint its own key and learn which models an account can serve.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const STATE_DIR = mkdtempSync(join(tmpdir(), 'nougate-host-'));
// What this file sets for itself, put back in `afterAll`: every later file in the suite runs in this process,
// and would otherwise find the gateway's home in a directory this one has deleted.
const ENV_SET = ['NOUGATE_DB_PATH', 'NOUGATE_HOME', 'SESSION_SECRET', 'SESSION_SECRET_FILE'] as const;
const envBefore = Object.fromEntries(ENV_SET.map((name) => [name, process.env[name]]));
process.env.NOUGATE_DB_PATH = join(STATE_DIR, 'host-test.db');
// A built dashboard to serve where none has been built — a checkout's own `apps/frontend/dist` still
// wins when it exists, and either is a relative build or an older absolute one, both handled.
process.env.NOUGATE_HOME = STATE_DIR;
mkdirSync(join(STATE_DIR, 'apps', 'frontend', 'dist'), { recursive: true });
writeFileSync(
  join(STATE_DIR, 'apps', 'frontend', 'dist', 'index.html'),
  '<!DOCTYPE html><html><head><script type="module" src="./assets/a.js"></script></head><body></body></html>',
);
process.env.SESSION_SECRET = 'host-test-session-secret-abcdefghijkl';
process.env.SESSION_SECRET_FILE = join(STATE_DIR, '.session-secret');

const { loadProxyConfig } = await import('@/config/manager');
const { initDb, closeDb } = await import('@/core/db');
const { initApiKeys, verifyApiKey } = await import('@/auth/api-keys');
const { setHostResolver, hostRequest, basePathFor } = await import('@/core/host');
const { enforceDashboardAuth, getActiveUser } = await import('@/auth/guard');
const { handleAuthRoute } = await import('@/router/auth');
const { renderEntryDocument, isEmbeddable } = await import('@/router/entry-document');
const { ensureHostKey } = await import('@/boot');
const { handleAdminRoute } = await import('@/router/admin');

const vouched = new WeakMap<Request, { username: string; basePath: string; apiOrigin?: string }>();

beforeAll(async () => {
  await loadProxyConfig();
  await initDb();
  await initApiKeys();
  setHostResolver((req) => vouched.get(req) ?? null);
});

afterAll(async () => {
  setHostResolver(null);
  await closeDb();
  rmSync(STATE_DIR, { recursive: true, force: true });
  for (const name of ENV_SET) {
    if (envBefore[name] === undefined) delete process.env[name];
    else process.env[name] = envBefore[name];
  }
});

function hostRequestFor(path: string, as = { username: 'owner', basePath: '/llm-gateway' }): Request {
  const req = new Request(`http://llm-gateway.internal${path}`);
  vouched.set(req, as);
  return req;
}

describe('who is signed in', () => {
  test('a request the host vouched for is its person, with nothing to change', async () => {
    const user = await getActiveUser(hostRequestFor('/api/auth/me'));
    expect(user?.username).toBe('owner');
    expect(user?.mustChangePassword).toBe(false);
    // Never a real account's id — the users page compares ids to stop a self-delete.
    expect(user?.id).toBe('host:owner');
  });

  test('the same path from the network, with no cookie, is nobody', async () => {
    // Not in the host's map: whatever it carries, the host never handed it over.
    const stranger = new Request('http://box:18256/api/providers', { headers: { 'x-forwarded-prefix': '/llm-gateway' } });
    expect(await getActiveUser(stranger)).toBeNull();
    const denied = await enforceDashboardAuth(stranger, new URL(stranger.url));
    expect(denied?.status).toBe(401);
  });

  test('the dashboard guard lets a vouched request through', async () => {
    const req = hostRequestFor('/api/providers');
    expect(await enforceDashboardAuth(req, new URL(req.url))).toBeNull();
  });

  test('who-am-I answers with the host\'s person', async () => {
    const req = hostRequestFor('/api/auth/me');
    const res = await handleAuthRoute(req, new URL(req.url));
    expect(res?.status).toBe(200);
    expect(((await res!.json()) as any).user.username).toBe('owner');
  });
});

describe('what the host may say', () => {
  test('a prefix that is not plain path segments is not believed', () => {
    for (const basePath of ['/llm gateway', '/x"><script>', 'llm-gateway', '/llm-gateway/', '//evil']) {
      expect(hostRequest(hostRequestFor('/', { username: 'owner', basePath }))).toBeNull();
    }
    expect(basePathFor(hostRequestFor('/', { username: 'owner', basePath: '/llm-gateway' }))).toBe('/llm-gateway');
  });

  test('an API origin that is more than an origin is dropped, the rest kept', () => {
    const found = hostRequest(hostRequestFor('/', { username: 'owner', basePath: '/llm-gateway', apiOrigin: 'http://box:18256/"x' } as any));
    expect(found).toEqual({ username: 'owner', basePath: '/llm-gateway' });
    const kept = hostRequest(hostRequestFor('/', { username: 'owner', basePath: '/llm-gateway', apiOrigin: 'http://10.0.0.5:18256' } as any));
    expect(kept?.apiOrigin).toBe('http://10.0.0.5:18256');
  });

  test('no name is no person', () => {
    expect(hostRequest(hostRequestFor('/', { username: '', basePath: '/llm-gateway' }))).toBeNull();
  });
});

describe('the entry document', () => {
  const built = [
    '<!DOCTYPE html><html><head>',
    '<link rel="icon" href="./favicon.svg" />',
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link href="https://fonts.googleapis.com/css2?family=Outfit" rel="stylesheet">',
    '<script type="module" crossorigin src="./assets/index-abc.js"></script>',
    '<link rel="stylesheet" crossorigin href="./assets/index-def.css">',
    '</head><body><div id="root"></div></body></html>',
  ].join('\n');

  test('on its own port, under /frontend/', () => {
    const html = renderEntryDocument(built, { basePath: '', embedded: false });
    expect(html).toContain('src="/frontend/assets/index-abc.js"');
    expect(html).toContain('href="/frontend/assets/index-def.css"');
    expect(html).toContain('href="/frontend/favicon.svg"');
    // Its own page keeps its fonts.
    expect(html).toContain('fonts.googleapis.com');
  });

  test('inside a host, under the host\'s prefix, without third-party fonts', () => {
    const html = renderEntryDocument(built, { basePath: '/llm-gateway', embedded: true, apiOrigin: 'http://box:18256' });
    expect(html).toContain('src="/llm-gateway/frontend/assets/index-abc.js"');
    expect(html).toContain('href="/llm-gateway/frontend/assets/index-def.css"');
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).not.toContain('fonts.gstatic.com');
  });

  test('what the page needs travels in a meta tag, escaped — never an inline script', () => {
    const html = renderEntryDocument(built, { basePath: '/llm-gateway', embedded: true, apiOrigin: 'http://box:18256' });
    const meta = /<meta name="nougate-host" content="([^"]*)" \/>/.exec(html)?.[1];
    expect(meta).toBeDefined();
    const decoded = meta!.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    expect(JSON.parse(decoded)).toEqual({ basePath: '/llm-gateway', embedded: true, apiOrigin: 'http://box:18256' });
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  test('a bundle from before the relative base is served as it was — its own port needs nothing more', () => {
    // A host never frames it (`isEmbeddable` is false for it), so there is no prefixed case to carry.
    const older = '<head><script type="module" src="/frontend/assets/a.js"></script></head>';
    expect(renderEntryDocument(older, { basePath: '', embedded: false })).toContain('src="/frontend/assets/a.js"');
    expect(isEmbeddable(older)).toBe(false);
  });
});

describe('serving the dashboard through a host', () => {
  test('the bare /frontend/ is the entry document, addressed for the host — not a raw file', async () => {
    // It resolves to `index.html`, which has a dot in it, and was once served as a static file: no
    // prefix, no host tag, and a page inside the host that called the host's own `/api`.
    const req = hostRequestFor('/frontend/');
    const res = await handleAdminRoute(req, new URL(req.url));
    const html = await res!.text();
    expect(html).toContain('<meta name="nougate-host"');
    expect(html).toContain('src="/llm-gateway/frontend/assets/');
  });

  test('a deep link is the same document', async () => {
    const req = hostRequestFor('/frontend/providers/codex');
    const html = await (await handleAdminRoute(req, new URL(req.url)))!.text();
    expect(html).toContain('src="/llm-gateway/frontend/assets/');
  });

  test('redirects stay under the host\'s prefix', async () => {
    for (const path of ['/', '/frontend/index.html']) {
      const req = hostRequestFor(path);
      const res = await handleAdminRoute(req, new URL(req.url));
      expect(res!.status).toBe(302);
      expect(res!.headers.get('location')).toBe('/llm-gateway/frontend/');
    }
  });

  test('on its own port the same document is addressed under /frontend/, and says it is not embedded', async () => {
    const req = new Request('http://box:18256/frontend/');
    const html = await (await handleAdminRoute(req, new URL(req.url)))!.text();
    expect(html).toContain('src="/frontend/assets/');
    expect(html).toContain('&quot;embedded&quot;:false');
  });
});

describe('the host\'s own key', () => {
  test('minted once, then handed back while it verifies', async () => {
    const first = await ensureHostKey('Nouride agents', null);
    expect(first.minted).toBe(true);
    expect(first.key.startsWith('sk-nou-')).toBe(true);
    expect(verifyApiKey(first.key).ok).toBe(true);

    const again = await ensureHostKey('Nouride agents', first.key);
    expect(again).toEqual({ key: first.key, minted: false });
  });

  test('a key that no longer verifies is replaced', async () => {
    const replaced = await ensureHostKey('Nouride agents', 'sk-nou-revoked-or-from-another-gateway');
    expect(replaced.minted).toBe(true);
    expect(verifyApiKey(replaced.key).ok).toBe(true);
  });
});

describe('whether the bundle on disk can be hosted', () => {
  test('a bundle built for host mode says so', () => {
    expect(isEmbeddable('<head><meta name="nougate-embeddable" content="1" /></head>')).toBe(true);
  });

  test('one from before host mode does not — a host must not frame it', () => {
    // It would call the host's own `/api` from inside the host's page.
    expect(isEmbeddable('<head><script type="module" src="/frontend/assets/a.js"></script></head>')).toBe(false);
  });
});
