/**
 * Sampling parameters the newer Claude models refuse outright.
 *
 * Anthropic answers `temperature`, `top_p` and `top_k` with a 400 on Opus 5, Opus 4.8, Sonnet 5 and
 * Fable 5.1 — "`temperature` is deprecated for this model" — rather than ignoring them. So an agent
 * configured with `temperature: 0.7` could not reach those models at all, while the same agent
 * worked on Sonnet 4.6. The split is per model, not per family, which is why the gateway carries a
 * list rather than a rule.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProxyConfig } from '@/config/manager';
import type { ProviderExecuteParams } from '@/core/interfaces';
import type { RequestContext } from '@/core/request-context';
import { ClaudeCodeProvider } from '@/providers/claudecode';
import * as manager from '@/providers/claudecode/auth/manager';
import { dropDeprecatedSampling } from '@/providers/claudecode/mappers/sampling';
import { claudeLiveSpecs, deprecatesSamplingParams, claudeCodeModelRegistry } from '@/providers/claudecode/config/model-specs';
import { CLAUDE_ANSWER } from './fixtures/upstream-models';

describe('which models refuse sampling parameters', () => {
  test('the split runs through both families, not along them', () => {
    // Verified against the live API on 2026-09-06. Sonnet appears on both sides, which is the whole
    // reason this cannot be derived from the model name.
    expect(deprecatesSamplingParams('claude-sonnet-5')).toBe(true);
    expect(deprecatesSamplingParams('claude-sonnet-4-6')).toBe(false);
    expect(deprecatesSamplingParams('claude-opus-5')).toBe(true);
    expect(deprecatesSamplingParams('claude-haiku-5-5')).toBe(true);
    expect(deprecatesSamplingParams('claude-haiku-4-5')).toBe(false);
  });

  test('the models that accept them are named only to say so, and a snapshot of one accepts too', () => {
    // A name in that table makes no model exist: before Anthropic answers, none is listed.
    expect(claudeCodeModelRegistry.listModelIds()).toEqual([]);
    expect(claudeCodeModelRegistry.getSpec('claude-sonnet-4-6')).toBeNull();
    for (const accepts of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-haiku-4.5']) {
      expect(deprecatesSamplingParams(accepts)).toBe(false);
    }
  });
});

describe('dropDeprecatedSampling', () => {
  test('removes all three from a model that refuses them', () => {
    const body = { model: 'claude-opus-5', temperature: 0.7, top_p: 0.9, top_k: 40, max_tokens: 16 };
    const out = dropDeprecatedSampling(body, 'claude-opus-5') as Record<string, unknown>;

    expect(out).not.toHaveProperty('temperature');
    expect(out).not.toHaveProperty('top_p');
    expect(out).not.toHaveProperty('top_k');
    expect(out.max_tokens).toBe(16);
  });

  test('drops temperature: 1 as well, which the upstream would have accepted', () => {
    // Anthropic's own default, so removing it changes nothing — and one unconditional rule beats
    // three exceptions that each have to be right.
    const out = dropDeprecatedSampling({ temperature: 1 }, 'claude-opus-5') as Record<string, unknown>;
    expect(out).not.toHaveProperty('temperature');
  });

  test('leaves a model that honours them untouched, by identity', () => {
    const body = { temperature: 0.7, top_p: 0.9 };
    // Same object back: a model that accepts sampling must not have its request rebuilt at all.
    expect(dropDeprecatedSampling(body, 'claude-sonnet-4-6')).toBe(body);
  });

  test('returns the same object when there is nothing to remove', () => {
    const body = { model: 'claude-opus-5', max_tokens: 16 };
    expect(dropDeprecatedSampling(body, 'claude-opus-5')).toBe(body);
  });

  test('does not mutate the caller\'s body', () => {
    // The body is shared with the metrics and compression paths; stripping in place would remove
    // parameters from a request other code is still reading.
    const body = { temperature: 0.7, max_tokens: 16 };
    dropDeprecatedSampling(body, 'claude-opus-5');
    expect(body.temperature).toBe(0.7);
  });

  test('survives a body that is not an object', () => {
    expect(dropDeprecatedSampling(null, 'claude-opus-5')).toBeNull();
    expect(dropDeprecatedSampling('not-json', 'claude-opus-5')).toBe('not-json');
  });
});

/**
 * A model not named as accepting them counts as refusing them. Every model Anthropic released from Opus
 * 4.7 on refuses them and the three that accept are older, so a model the table does not name is far
 * likelier to refuse than to need them; and a dropped temperature still answers, where one sent to a
 * model that refuses it is a 400.
 */
describe('a model not known to accept sampling', () => {
  const realFetch = globalThis.fetch;
  const dirs: string[] = [];

  afterEach(() => {
    globalThis.fetch = realFetch;
    claudeCodeModelRegistry.mergeLive([]);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    delete process.env.CLAUDE_CODE_ACCOUNTS_FILE;
  });

  test('counts as refusing sampling unless it is known to accept it', () => {
    for (const refuses of ['claude-opus-4-5-20251101', 'claude-opus-5-5', 'claude-opus-6', 'claude-sonnet-6.1']) {
      expect(deprecatesSamplingParams(refuses)).toBe(true);
    }
    for (const accepts of ['claude-sonnet-4-6', 'claude-sonnet-4.6', 'claude-opus-4-6', 'claude-haiku-4-5']) {
      expect(deprecatesSamplingParams(accepts)).toBe(false);
    }
  });

  /** One request on the Anthropic wire with sampling set; the body Anthropic is sent. */
  async function sent(modelId: string): Promise<Record<string, unknown>> {
    await loadProxyConfig();
    const dir = mkdtempSync(join(tmpdir(), 'nougate-claudecode-sampling-'));
    dirs.push(dir);
    process.env.CLAUDE_CODE_ACCOUNTS_FILE = join(dir, 'accounts.json');
    await manager.initManager();
    await manager.addAccount('sk-ant-api03-sampling-test');
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        id: 'msg_1', type: 'message', role: 'assistant', model: modelId,
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as typeof fetch;

    const provider = new ClaudeCodeProvider();
    const response = await provider.execute({
      protocol: 'anthropic',
      body: { model: `claudecode:${modelId}`, max_tokens: 16, temperature: 0.7, top_p: 0.9, messages: [{ role: 'user', content: 'hello' }] },
      resolvedModel: { providerId: 'claudecode', modelId, raw: `claudecode:${modelId}` },
      modelSpec: claudeCodeModelRegistry.getSpec(modelId)!,
      ctx: { sessionId: 'sampling', clientId: 'test' } as unknown as RequestContext,
    } as ProviderExecuteParams);
    expect(response.status).toBe(200);
    await response.text();
    return body;
  }

  test('is sent no sampling parameters, where a model known to accept them is', async () => {
    claudeCodeModelRegistry.mergeLive(
      claudeLiveSpecs([...CLAUDE_ANSWER, { type: 'model', id: 'claude-opus-6-test', display_name: 'Claude Opus 6 Test', max_tokens: 128_000 }]),
    );
    const live = await sent('claude-opus-6-test');
    expect(live.model).toBe('claude-opus-6-test');
    expect(live).not.toHaveProperty('temperature');
    expect(live).not.toHaveProperty('top_p');

    const written = await sent('claude-sonnet-4-6');
    expect(written).toMatchObject({ temperature: 0.7, top_p: 0.9 });
  });
});
