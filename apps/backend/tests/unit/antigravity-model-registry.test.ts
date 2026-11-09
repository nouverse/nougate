/**
 * Antigravity's models are the ones Google's `fetchAvailableModels` lists, and each request is shaped
 * by what that list says about the model, not by its name.
 *
 * No id is written down. What is offered is read from the reply's own fields: internal models and
 * those it names nothing are not, ids it gives one display name are one model, a model listed as
 * `<family>-tiered` is offered at Google's level ids. Each spec carries the reply's facts (maker,
 * thinking by level, file types, limits), and the mappers shape the Google request by them, so a
 * `gemini-4-*` or a Claude named some new way is shaped right without a code change.
 *
 * The fixture is the two live accounts' replies of 2026-11-09, one moved to Claude 5.5 and one not.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadProxyConfig } from '@/config/manager';
import type { IModelSpec } from '@/core/interfaces';
import { antigravityModelRegistry, antigravitySpecs, parseListedModels } from '@/providers/antigravity/config/model-specs';
import { shapeOf, type AntigravityModelSpec } from '@/providers/antigravity/config/shape';
import { mapOpenAIToGoogle } from '@/providers/antigravity/mappers/openai-in';
import { mapAnthropicToGoogle } from '@/providers/antigravity/mappers/anthropic-in';
import { getClientHeaders, generateFingerprint } from '@/providers/antigravity/upstream/headers';
import { ANTIGRAVITY_MOVED_REPLY, clearSeeds, seedAntigravity } from './fixtures/upstream-models';

beforeAll(async () => {
  // The mappers read the proxy config (system prompt, compression).
  await loadProxyConfig();
  seedAntigravity();
});
afterAll(() => clearSeeds());

const OFFERED = [
  'claude-opus-4-6-thinking',
  'claude-opus-5-5-high',
  'claude-opus-5-5-low',
  'claude-opus-5-5-medium',
  'claude-sonnet-4-6',
  'claude-sonnet-5-5-high',
  'claude-sonnet-5-5-low',
  'claude-sonnet-5-5-medium',
  'gemini-2.5-pro',
  'gemini-3-flash',
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-low',
  'gemini-3.8-flash-medium',
  'gpt-oss-120b-medium',
];

describe('what Antigravity offers, from the reply', () => {
  test('the models the two accounts list together, and nothing written down', () => {
    expect(antigravityModelRegistry.listModelIds()).toEqual(OFFERED);
  });

  test("not the reply's internal models, nor those it names nothing", () => {
    const ids = parseListedModels(ANTIGRAVITY_MOVED_REPLY).map((model) => model.id);
    for (const left of ['chat_20706', 'chat_23310', 'tab_flash_lite_preview', 'tab_jump_flash_lite_preview']) {
      expect(ids).not.toContain(left);
    }
  });

  test('not a model the reply marks internal, even one it names', () => {
    // Not in the 2026-11-09 replies, whose internal models also had no name: the mark alone decides.
    const reply = {
      models: {
        'chat_named': { displayName: 'Internal Chat', isInternal: true, apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' },
        'helper_named': { displayName: 'Internal Helper', apiProvider: 'API_PROVIDER_INTERNAL' },
        'gemini-test': { displayName: 'Gemini Test', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', modelProvider: 'MODEL_PROVIDER_GOOGLE' },
      },
    };
    expect(parseListedModels(reply).map((model) => model.id)).toEqual(['gemini-test']);
  });

  test('ids the reply gives one display name are one model, the one whose id is that name', () => {
    for (const alias of ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash-thinking']) {
      expect(antigravityModelRegistry.getSpec(alias)).toBeNull();
    }
    expect(antigravityModelRegistry.getSpec('gemini-3.5-flash-lite')?.displayName).toBe('Gemini 3.5 Flash Lite');
  });

  test("a model with a removal notice is offered until Google's list drops it", () => {
    expect(antigravityModelRegistry.getSpec('gpt-oss-120b-medium')).toMatchObject({ displayName: 'GPT-OSS 120B (Medium)', maxOutputTokens: 32768 });
  });

  test('getSpec is case- and whitespace-insensitive', () => {
    expect(antigravityModelRegistry.getSpec('  GEMINI-3-FLASH  ')?.modelId).toBe('gemini-3-flash');
  });
});

describe('Antigravity Gemini 3.8 Flash, listed as gemini-3.8-flash-tiered', () => {
  test('low, medium and high are offered, under the family name Google gives nothing for', () => {
    expect(antigravityModelRegistry.getSpec('gemini-3.8-flash-low')?.displayName).toBe('Gemini 3.8 Flash (Low)');
    expect(antigravityModelRegistry.getSpec('gemini-3.8-flash-tiered')).toBeNull();
  });

  test('the bare gemini-3.8-flash goes to Medium, never to tiered', () => {
    const spec = antigravityModelRegistry.getSpec('gemini-3.8-flash')!;
    expect(spec.upstreamModelId).toBe('gemini-3.8-flash-medium');
    expect(spec.thinkingBudget).toBeUndefined();
  });

  for (const level of ['low', 'medium', 'high']) {
    test(`${level} goes to Google under its own id, thinking by level, with no budget of ours`, () => {
      const spec = antigravityModelRegistry.getSpec(`gemini-3.8-flash-${level}`)! as AntigravityModelSpec;
      expect(spec.upstreamModelId ?? spec.modelId).toBe(`gemini-3.8-flash-${level}`);
      expect(spec.thinkingBudget).toBeUndefined();
      expect(spec.isThinking).toBe(true);
      expect(spec.thinksByLevel).toBe(true);
      expect(spec.maxOutputTokens).toBe(65536);
    });
  }
});

describe('Antigravity Claude', () => {
  for (const id of ['claude-sonnet-5-5-low', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-high', 'claude-opus-5-5-low', 'claude-opus-5-5-medium', 'claude-opus-5-5-high']) {
    test(`${id} goes to Google under its own id, thinking, with no budget of ours`, () => {
      const spec = antigravityModelRegistry.getSpec(id)!;
      expect(spec.upstreamModelId ?? spec.modelId).toBe(id);
      expect(spec.isThinking).toBe(true);
      expect(spec.thinkingBudget).toBeUndefined();
      expect(spec.maxOutputTokens).toBe(128000);
    });
  }

  test("a Claude that thinks by budget gets ours, not the reply's least one", () => {
    for (const id of ['claude-sonnet-4-6', 'claude-opus-4-6-thinking']) {
      expect(antigravityModelRegistry.getSpec(id)).toMatchObject({ isThinking: true, thinkingBudget: 32768, maxOutputTokens: 64000 });
    }
  });

  test('a Gemini that thinks by budget is sent none, and thinks as Google decides', () => {
    expect(antigravityModelRegistry.getSpec('gemini-2.5-pro')).toMatchObject({ isThinking: true, thinksByLevel: false });
    expect(antigravityModelRegistry.getSpec('gemini-2.5-pro')?.thinkingBudget).toBeUndefined();
  });
});

describe('what each takes, from the file types the reply lists', () => {
  test('Gemini hears and sees, Claude sees, the image model sees', () => {
    expect(antigravityModelRegistry.getSpec('gemini-3-flash')?.inputModalities).toEqual(['text', 'image', 'audio']);
    expect(antigravityModelRegistry.getSpec('claude-sonnet-4-6')?.inputModalities).toEqual(['text', 'image']);
    expect(antigravityModelRegistry.getSpec('gemini-3.1-flash-image')?.inputModalities).toEqual(['text', 'image']);
    expect(antigravityModelRegistry.getSpec('gpt-oss-120b-medium')?.inputModalities).toEqual(['text']);
  });
});

/** A spec built from facts alone, for a model the fixture does not have. */
function factSpec(modelId: string, facts: { maker: string; thinksByLevel: boolean }): IModelSpec {
  const [spec] = antigravitySpecs([
    { id: modelId, name: modelId, maker: facts.maker, images: true, audio: false, thinking: true, ...(facts.thinksByLevel ? { thinkingLevel: 2 } : {}), tiered: false },
  ]);
  return spec!;
}

const toolTurn = {
  messages: [
    { role: 'user', content: 'What is the weather?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"Jakarta"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"sky":"clear"}' },
  ],
  tools: [{ type: 'function', function: { name: 'weather', description: 'Weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
};

function parts(result: any) {
  const all = result.request.contents.flatMap((content: any) => content.parts);
  return { call: all.find((part: any) => part.functionCall), response: all.find((part: any) => part.functionResponse) };
}

describe('the request is shaped by the facts, not the name', () => {
  test("a Gemini of a generation the code has never seen, thinking by level: call ids and Gemini's signature check", () => {
    const spec = factSpec('gemini-4-test', { maker: 'google', thinksByLevel: true });
    expect(shapeOf(spec)).toMatchObject({ callIds: true, signatures: true, validatedTools: false, grounding: true });

    const { call, response } = parts(mapOpenAIToGoogle(toolTurn, spec, 'session-gemini-4'));
    expect(call.functionCall.id).toBe('call_1');
    expect(call.thoughtSignature).toBeDefined();
    expect(response.functionResponse.id).toBe('call_1');
  });

  test('a Claude whose id does not say claude: call ids, validated tool calls, the Anthropic gate, no signatures', () => {
    const spec = factSpec('opus-next-test', { maker: 'anthropic', thinksByLevel: false });
    expect(shapeOf(spec)).toMatchObject({ callIds: true, signatures: false, validatedTools: true, grounding: false, anthropic: true });

    const result = mapOpenAIToGoogle(toolTurn, spec, 'session-opus-next');
    expect(result.request.toolConfig).toEqual({ functionCallingConfig: { mode: 'VALIDATED' } });
    expect(parts(result).call.functionCall.id).toBe('call_1');
    expect(parts(result).call.thoughtSignature).toBeUndefined();
    expect(getClientHeaders('token', generateFingerprint('a@test.invalid'), shapeOf(spec).anthropic)['anthropic-beta']).toBe('interleaved-thinking-2025-05-14');
  });

  test('a Gemini that thinks by budget, as Gemini 2.5 Pro: no call ids, no signature check', () => {
    const spec = antigravityModelRegistry.getSpec('gemini-2.5-pro')!;
    const { call, response } = parts(mapOpenAIToGoogle(toolTurn, spec, 'session-gemini-2-5'));
    expect(call.functionCall.id).toBeUndefined();
    expect(call.thoughtSignature).toBeUndefined();
    expect(response.functionResponse.id).toBeUndefined();
  });

  test('the Anthropic wire is shaped the same way', () => {
    const spec = factSpec('gemini-4-test', { maker: 'google', thinksByLevel: true });
    const body = {
      model: 'antigravity:gemini-4-test',
      max_tokens: 64,
      messages: [
        { role: 'user', content: 'What is the weather?' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'weather', input: { city: 'Jakarta' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"sky":"clear"}' }] },
      ],
    };
    const { call, response } = parts(mapAnthropicToGoogle(body as any, spec, 'session-anthropic-gemini-4'));
    expect(call.functionCall.id).toBe('toolu_1');
    expect(call.thoughtSignature).toBeDefined();
    expect(response.functionResponse.id).toBe('toolu_1');
  });
});

describe('no file that shapes the Google request reads the model name', () => {
  // Facts come from Google's list (`config/shape.ts`); a name check here is how a new model ends up
  // shaped for whichever family its name happens to match.
  test.each(['mappers/openai-in.ts', 'mappers/anthropic-in.ts', 'upstream/executor.ts', 'upstream/headers.ts', 'config/audio.ts', 'utils/thought-signature.ts'])(
    '%s',
    (file) => {
      const source = readFileSync(join(import.meta.dir, '..', '..', 'src', 'providers', 'antigravity', file), 'utf8');
      expect(source).not.toMatch(/includes\((['"])(claude|gemini|gemini-3|flash|thinking|anthropic)\1\)/);
    },
  );

  test('the executor takes the Claude path by the spec', () => {
    const source = readFileSync(join(import.meta.dir, '..', '..', 'src', 'providers', 'antigravity', 'upstream', 'executor.ts'), 'utf8');
    expect(source).toContain('const isClaudeModel = shapeOf(options.modelSpec).anthropic;');
    expect(source).toContain('getClientHeaders(account.accessToken, account.fingerprint!, isClaudeModel)');
  });
});
