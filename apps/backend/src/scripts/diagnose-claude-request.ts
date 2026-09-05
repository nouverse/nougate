/**
 * One real request to Anthropic with a stored credential, printed in full when it fails.
 *
 * Exists because "it does not work" and "the gateway is broken" are the same sentence from outside,
 * and the difference is usually one header. This sends the smallest valid request, then — on failure —
 * retries with pieces removed until it finds the piece responsible, so the answer is a name rather
 * than a guess.
 *
 *   bun run src/scripts/diagnose-claude-request.ts
 *   bun run src/scripts/diagnose-claude-request.ts --tools    # include a tool, exercising the rename
 */

import { initManager, getAccounts } from '@/providers/claude-code/auth/manager';
import { loadClaudeCodeConfig, getClaudeCodeConfig } from '@/providers/claude-code/config/provider-config';
import { buildRequestHeaders, DEFAULT_BETA_FEATURES } from '@/providers/claude-code/upstream/headers';
import { cloakToolNames } from '@/providers/claude-code/mappers/tool-names';

const withTools = process.argv.includes('--tools');

await loadClaudeCodeConfig();
await initManager();

const accounts = getAccounts().filter((a) => !a.invalidatedAt);
if (accounts.length === 0) {
  console.error('No Claude Code credentials stored. Add one on the provider page first.');
  process.exit(1);
}

const account = accounts[0]!;
const config = getClaudeCodeConfig();
console.log(`credential : ${account.label} (${account.kind})`);
console.log(`expires    : ${account.expiresAt ? new Date(account.expiresAt).toISOString() : 'not set'}`);
console.log(`refresh    : ${account.refreshToken ? 'present' : 'none'}`);
console.log(`baseUrl    : ${config.baseUrl}`);

const baseBody: any = {
  model: 'claude-haiku-4-5',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
};

if (withTools) {
  baseBody.tools = [
    { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: {} } },
  ];
}

const { body, toolNameMap } = config.cloakToolNames
  ? cloakToolNames(baseBody, config.toolNameSuffix)
  : { body: baseBody, toolNameMap: null };

if (toolNameMap) console.log(`renamed    : ${[...toolNameMap.keys()].join(', ')}`);

/** Send one request and report what came back, without throwing on a bad status. */
async function attempt(label: string, headers: Record<string, string>, url: string) {
  process.stdout.write(`\n[${label}]\n  ${Object.keys(headers).join(', ')}\n`);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await res.text();
    console.log(`  -> ${res.status} ${res.statusText}`);
    console.log(`  -> ${text.slice(0, 500)}`);
    return res.ok;
  } catch (error) {
    console.log(`  -> threw: ${String(error).slice(0, 300)}`);
    return false;
  }
}

const url = `${config.baseUrl.replace(/\/$/, '')}/v1/messages?beta=true`;
const full = buildRequestHeaders(account.credential);

if (await attempt('as the gateway sends it', full, url)) {
  console.log('\nWorks. The gateway request itself is fine.');
  process.exit(0);
}

// It failed. Narrow it: the beta gate list is by far the most common cause — one retired or unknown
// gate is a 400 on every request, and the message rarely names which.
console.log('\nFailed. Narrowing down which part is responsible...\n');

const minimal = { ...full, 'anthropic-beta': 'oauth-2025-04-20' };
if (await attempt('only the oauth gate', minimal, url)) {
  console.log('\n=> A beta gate in the list is being rejected. Bisecting it:\n');
  for (const feature of DEFAULT_BETA_FEATURES) {
    const ok = await attempt(
      `oauth + ${feature}`,
      { ...full, 'anthropic-beta': `oauth-2025-04-20,${feature}` },
      url,
    );
    if (!ok) console.log(`   ^ ${feature} is the one to drop from betaFeatures`);
  }
  process.exit(1);
}

const noBeta = { ...full };
delete noBeta['anthropic-beta'];
if (await attempt('no beta header at all', noBeta, url)) {
  console.log('\n=> The oauth gate itself is being rejected — likely an API key on the wrong header.');
  process.exit(1);
}

if (await attempt('without the ?beta=true suffix', full, url.replace('?beta=true', ''))) {
  console.log('\n=> The ?beta=true suffix is the problem.');
  process.exit(1);
}

console.log('\n=> Not a header. The credential itself is being rejected — check expiry and re-auth.');
process.exit(1);
