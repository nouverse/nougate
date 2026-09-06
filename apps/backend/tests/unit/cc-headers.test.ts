/**
 * The beta gates, which fail by doing nothing rather than by erroring.
 *
 * A capability missing from `anthropic-beta` is not rejected — it is ignored. A client asks for
 * interleaved thinking, gets ordinary thinking, and nothing anywhere says why. That is the reason
 * these are asserted rather than trusted.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { buildRequestHeaders, DEFAULT_BETA_FEATURES } from '@/providers/cc/upstream/headers';
import { updateClaudeCodeConfig } from '@/providers/cc/config/provider-config';

const OAUTH_TOKEN = 'sk-ant-oat01-token';
const API_KEY = 'sk-ant-api03-key';

afterEach(async () => {
  await updateClaudeCodeConfig({ betaFeatures: [] });
});

const betas = (credential: string) =>
  (buildRequestHeaders(credential)['anthropic-beta'] ?? '').split(',');

describe('an OAuth credential', () => {
  test('carries the bearer header and the oauth gate', async () => {
    const headers = buildRequestHeaders(OAUTH_TOKEN);

    expect(headers.authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
    expect(headers['x-api-key']).toBeUndefined();
    // Without this a perfectly valid token 401s on /v1/messages — the single most confusing failure
    // on this path.
    expect(betas(OAUTH_TOKEN)).toContain('oauth-2025-04-20');
  });

  test('asks for the feature gates the request body relies on', async () => {
    const list = betas(OAUTH_TOKEN);
    for (const feature of DEFAULT_BETA_FEATURES) {
      expect(list).toContain(feature);
    }
  });

  test('the oauth gate is never sent twice', async () => {
    // `authHeaders` already contributes it; a configured list repeating it would be a 400.
    await updateClaudeCodeConfig({ betaFeatures: ['oauth-2025-04-20', 'effort-2025-11-24'] });
    const list = betas(OAUTH_TOKEN);

    expect(list.filter((value) => value === 'oauth-2025-04-20').length).toBe(1);
  });
});

describe('an API key', () => {
  test('goes on x-api-key and does not claim the oauth gate', async () => {
    const headers = buildRequestHeaders(API_KEY);

    expect(headers['x-api-key']).toBe(API_KEY);
    expect(headers.authorization).toBeUndefined();
    expect(betas(API_KEY)).not.toContain('oauth-2025-04-20');
  });

  test('still gets the feature gates, which are not OAuth-specific', async () => {
    expect(betas(API_KEY)).toContain('context-management-2025-06-27');
  });
});

describe('operator configuration', () => {
  test('a configured list replaces the defaults rather than merging', async () => {
    // The reason to touch this is usually a gate that graduated and is now rejected as unknown — a
    // merge could not remove one.
    await updateClaudeCodeConfig({ betaFeatures: ['only-this-one'] });
    const list = betas(OAUTH_TOKEN);

    expect(list).toContain('only-this-one');
    expect(list).not.toContain('effort-2025-11-24');
    // The credential's own requirement survives an operator's replacement list.
    expect(list).toContain('oauth-2025-04-20');
  });

  test('an empty list means the defaults, not "send nothing"', async () => {
    // That is what a config file written before this field existed looks like, and reading it as
    // "disable every capability" would silently downgrade an upgraded gateway.
    await updateClaudeCodeConfig({ betaFeatures: [] });
    expect(betas(OAUTH_TOKEN)).toContain('effort-2025-11-24');
  });

  test('blank entries are filtered rather than sent as an empty gate', async () => {
    await updateClaudeCodeConfig({ betaFeatures: ['  ', 'effort-2025-11-24'] });
    expect(betas(OAUTH_TOKEN)).not.toContain('');
  });
});

describe('the rest of the request', () => {
  test('anthropic-version and a JSON content type are always present', async () => {
    const headers = buildRequestHeaders(OAUTH_TOKEN);
    // Omitting the version is a 400, not a default.
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['content-type']).toBe('application/json');
  });
});
