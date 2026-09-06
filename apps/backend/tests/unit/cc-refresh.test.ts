/**
 * Turning a CLI's stdout into a token.
 *
 * The whole reason this provider can hold a subscription credential without a daily re-paste, and
 * the parsing is where it goes wrong silently: a notice printed above the value, concatenated into
 * the credential, produces a 401 that reads exactly like an expired token.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { updateClaudeCodeConfig } from '@/providers/cc/config/provider-config';
import { refreshAccessToken } from '@/providers/cc/upstream/refresh';

afterEach(async () => {
  await updateClaudeCodeConfig({ refreshCommand: '' });
});

describe('when it is off', () => {
  test('no command configured is a stated reason, not an empty token', async () => {
    // The executor puts this string on the account as its invalid reason, so an operator who never
    // configured a refresh is told that, rather than being told their token is bad.
    await updateClaudeCodeConfig({ refreshCommand: '' });
    expect(await refreshAccessToken()).toEqual({ error: 'no refresh command configured' });
  });
});

describe('reading what the command printed', () => {
  test('a bare token is the token', async () => {
    await updateClaudeCodeConfig({ refreshCommand: 'echo sk-ant-oat01-fresh' });
    expect((await refreshAccessToken()).token).toBe('sk-ant-oat01-fresh');
  });

  test('a notice above the value is not part of the value', async () => {
    // Real CLIs print things. Concatenating a banner into the credential is a 401 nobody can read.
    await updateClaudeCodeConfig({
      refreshCommand: 'printf "Refreshing credentials...\\nsk-ant-oat01-fresh\\n"',
    });
    expect((await refreshAccessToken()).token).toBe('sk-ant-oat01-fresh');
  });

  test('trailing blank lines do not become the token', async () => {
    await updateClaudeCodeConfig({ refreshCommand: 'printf "sk-ant-oat01-fresh\\n\\n\\n"' });
    expect((await refreshAccessToken()).token).toBe('sk-ant-oat01-fresh');
  });

  test('a command that printed nothing yields no token', async () => {
    await updateClaudeCodeConfig({ refreshCommand: 'true' });
    const result = await refreshAccessToken();
    expect(result.token).toBeUndefined();
    expect(result.error).toBe('refresh command printed nothing');
  });
});

describe('when the command fails', () => {
  test('a non-zero exit is reported with its own stderr, not as a missing token', async () => {
    await updateClaudeCodeConfig({ refreshCommand: 'echo "not logged in" >&2; exit 3' });
    const result = await refreshAccessToken();

    expect(result.token).toBeUndefined();
    expect(result.error).toContain('exited 3');
    // The operator's actual problem, carried through rather than flattened into "refresh failed".
    expect(result.error).toContain('not logged in');
  });

  test('stderr is truncated, because a failing CLI can print a great deal of it', async () => {
    await updateClaudeCodeConfig({
      refreshCommand: `printf '%0.sx' $(seq 1 5000) >&2; exit 1`,
    });
    const result = await refreshAccessToken();

    expect(result.error!.length).toBeLessThan(300);
  });
});
