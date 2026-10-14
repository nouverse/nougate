/**
 * Body-level Claude transformations — billing header injection, user ID metadata, and applyCloaking.
 */

import { describe, expect, test } from 'bun:test';
import {
  applyCloaking,
  deriveUuid,
  generateBillingHeader,
  generateFakeUserID,
} from '@/providers/claudecode/upstream/body-cloaking';

describe('generateBillingHeader', () => {
  test('format matches cc_version=<ver>.<build>; cc_entrypoint=sdk-cli; cch=<hash>;', () => {
    const header = generateBillingHeader({ model: 'claude-sonnet-4-20250514' });
    expect(header).toStartWith('x-anthropic-billing-header: cc_version=2.1.299.');
    expect(header).toContain('cc_entrypoint=sdk-cli');
    expect(header).toMatch(/cch=[a-f0-9]{5};$/);
  });

  test('cch changes when payload changes', () => {
    const h1 = generateBillingHeader({ model: 'claude-sonnet-4-20250514' });
    const h2 = generateBillingHeader({ model: 'claude-opus-4-20250514' });
    const cch1 = h1.match(/cch=([a-f0-9]{5})/)?.[1];
    const cch2 = h2.match(/cch=([a-f0-9]{5})/)?.[1];
    expect(cch1).not.toBe(cch2);
  });
});

describe('deriveUuid', () => {
  test('produces a UUID-v4-shaped string', () => {
    const uuid = deriveUuid('test-seed');
    expect(uuid).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  });

  test('is deterministic — same seed, same UUID', () => {
    expect(deriveUuid('stable')).toBe(deriveUuid('stable'));
  });

  test('different seeds produce different UUIDs', () => {
    expect(deriveUuid('a')).not.toBe(deriveUuid('b'));
  });
});

describe('generateFakeUserID', () => {
  test('produces valid JSON with device_id, account_uuid, session_id', () => {
    const result = JSON.parse(generateFakeUserID('sess-1', 'sk-ant-oat-test'));
    expect(result.device_id).toMatch(/^[a-f0-9]{64}$/);
    expect(result.account_uuid).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect(result.session_id).toBe('sess-1');
  });

  test('device_id is stable per API key', () => {
    const a = JSON.parse(generateFakeUserID(undefined, 'key-1'));
    const b = JSON.parse(generateFakeUserID(undefined, 'key-1'));
    expect(a.device_id).toBe(b.device_id);
    expect(a.account_uuid).toBe(b.account_uuid);
  });

  test('without an API key, device_id is random', () => {
    const a = JSON.parse(generateFakeUserID(undefined, undefined));
    const b = JSON.parse(generateFakeUserID(undefined, undefined));
    // Extremely unlikely to collide
    expect(a.device_id).not.toBe(b.device_id);
  });
});

describe('applyCloaking', () => {
  test('skips everything for non-OAuth (isOAuth = false)', () => {
    const body = { model: 'test', system: 'hello' };
    expect(applyCloaking(body, false)).toBe(body);
  });

  test('injects billing header as system[0] when system is an array', () => {
    const body = {
      model: 'test',
      system: [{ type: 'text', text: 'You are helpful.' }],
    };
    const result = applyCloaking(body, true, 'sess', 'key');
    expect(result.system.length).toBe(2);
    expect(result.system[0].text).toStartWith('x-anthropic-billing-header:');
    expect(result.system[1].text).toBe('You are helpful.');
  });

  test('injects billing header when system is a string', () => {
    const body = { model: 'test', system: 'Be concise.' };
    const result = applyCloaking(body, true, 'sess', 'key');
    expect(result.system.length).toBe(2);
    expect(result.system[0].text).toStartWith('x-anthropic-billing-header:');
    expect(result.system[1].text).toBe('Be concise.');
  });

  test('injects billing header when system is absent', () => {
    const body = { model: 'test' };
    const result = applyCloaking(body, true, 'sess', 'key');
    expect(result.system.length).toBe(1);
    expect(result.system[0].text).toStartWith('x-anthropic-billing-header:');
  });

  test('does not double-inject billing header', () => {
    const body = {
      model: 'test',
      system: [{ type: 'text', text: 'x-anthropic-billing-header: already here' }],
    };
    const result = applyCloaking(body, true, 'sess', 'key');
    expect(result.system.length).toBe(1);
  });

  test('injects fake user_id into metadata', () => {
    const result = applyCloaking({ model: 'test' }, true, 'sess-1', 'key-1');
    expect(result.metadata.user_id).toBeDefined();
    const parsed = JSON.parse(result.metadata.user_id);
    expect(parsed.session_id).toBe('sess-1');
  });

  test('does not overwrite existing user_id', () => {
    const body = { model: 'test', metadata: { user_id: 'already-set' } };
    const result = applyCloaking(body, true, 'sess', 'key');
    expect(result.metadata.user_id).toBe('already-set');
  });
});
