/**
 * A model Copilot will not serve here costs the account nothing, and is answered at once.
 *
 * Copilot answers a model it serves only on /responses with 400 `unsupported_api_for_model`, and one
 * it does not know with 404. Both are the model's, the same on every account. The executor named them
 * for the client (`ModelUnavailableError`) but threw inside its own try block, whose catch charged
 * the account as a 500 and asked again: on 2026-11-09 a request to copilot:gpt-6-luna and one to
 * copilot:gpt-5.6-luna, tried three times each, took the only account from 100 to 40 health.
 *
 * The executor runs in a Bun process of its own: picking a Copilot account saves the pool, to a file
 * this process fixes when the module loads, so only a fresh process can point it at a scratch
 * directory. `fetch` is stubbed there; nothing reaches GitHub.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BACKEND = join(import.meta.dir, '..', '..');
const home = mkdtempSync(join(tmpdir(), 'nougate-copilot-refused-'));

afterAll(() => rmSync(home, { recursive: true, force: true }));

/**
 * Run the executor once against an upstream that answers `status` with `body`, or whose connection
 * fails when `status` is 0; what it threw and what it cost.
 */
async function refused(status: number, body: string) {
  const dir = mkdtempSync(join(home, 'case-'));
  writeFileSync(
    join(dir, 'accounts.json'),
    JSON.stringify({
      strategy: 'hybrid',
      accounts: [
        {
          id: 'copilot-test',
          providerId: 'copilot',
          personalToken: 'test-personal-token',
          sessionToken: 'test-session-token',
          sessionTokenExpiresAt: Date.now() + 3_600_000,
          healthScore: 100,
          lastUsed: 0,
          status: 'active',
        },
      ],
    }),
  );
  const code = `
    import { loadProxyConfig } from '@/config/manager';
    import { getAccounts, initManager } from '@/providers/copilot/auth/manager';
    import { CopilotExecutor } from '@/providers/copilot/upstream/executor';
    console.log = () => {}; console.error = () => {}; console.warn = () => {};
    await loadProxyConfig();
    await initManager();
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (${status} === 0) throw new TypeError('connection refused');
      return new Response(${JSON.stringify(body)}, { status: ${status} });
    };
    const modelSpec = { modelId: 'gpt-6-luna', upstreamModelId: 'gpt-6-luna', pool: 'cli', isThinking: false, maxOutputTokens: 8192, timeoutMs: 60000 };
    const thrown = await new CopilotExecutor().execute({ body: { messages: [{ role: 'user', content: 'hi' }] }, modelSpec }).catch((error) => error);
    const account = getAccounts()[0];
    process.stdout.write(JSON.stringify({ name: thrown?.name, status: thrown?.status, clientCode: thrown?.clientCode, calls, health: account.healthScore, failures: account.consecutiveFailures ?? 0 }));
    process.exit(0);
  `;
  const child = Bun.spawn([process.execPath, '-e', code], {
    cwd: BACKEND,
    env: { ...process.env, NOUGATE_HOME: dir, COPILOT_ACCOUNTS_FILE: join(dir, 'accounts.json'), CONFIG_FILE: join(dir, 'config.json') },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (!stdout) throw new Error(`the child printed nothing: ${stderr.slice(0, 500)}`);
  return JSON.parse(stdout) as { name?: string; status?: number; clientCode?: string; calls: number; health: number; failures: number };
}

describe('a model Copilot will not serve here', () => {
  test('served only on /responses: one try, a 404 the client can read, no health lost', async () => {
    const result = await refused(
      400,
      '{"error":{"message":"model \\"gpt-6-luna\\" is not accessible via the /chat/completions endpoint","code":"unsupported_api_for_model"}}',
    );
    expect(result).toEqual({ name: 'ModelUnavailableError', status: 404, clientCode: 'model_not_found', calls: 1, health: 100, failures: 0 });
  });

  test('not known to Copilot, as it answers a 400 for that: the same', async () => {
    const result = await refused(
      400,
      '{"error":{"message":"The requested model is not supported.","code":"model_not_supported","param":"model","type":"invalid_request_error"}}',
    );
    expect(result).toEqual({ name: 'ModelUnavailableError', status: 404, clientCode: 'model_not_found', calls: 1, health: 100, failures: 0 });
  });

  test('not known at all: the same', async () => {
    const result = await refused(404, '{"error":{"message":"The requested model is not supported.","code":"model_not_supported"}}');
    expect(result).toEqual({ name: 'ModelUnavailableError', status: 404, clientCode: 'model_not_found', calls: 1, health: 100, failures: 0 });
  });

  test('a server error, or a connection that fails, is still charged and asked again', async () => {
    for (const status of [500, 0]) {
      const result = await refused(status, '{"error":{"message":"internal error"}}');
      expect(result.calls).toBeGreaterThan(1);
      expect(result.health).toBeLessThan(100);
    }
  });
});
