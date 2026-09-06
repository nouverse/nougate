/**
 * The Anthropic → Anthropic passthrough.
 *
 * A passthrough's bugs are all the same bug: it quietly dropped something. The client sends a current
 * request, the gateway forwards an older one, and the only symptom is a feature that stopped working
 * with no error anywhere. So these tests are mostly about what *survives*.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { loadProxyConfig } from '@/config/manager';
import { sanitizeAnthropicBody } from '@/core/mappers/anthropic-passthrough';

// The mapper asks the proxy config whether Caveman mode is on, and that config has to be loaded
// before anything reads it — same bootstrap every other mapper test does.
beforeAll(async () => {
  await loadProxyConfig();
});

describe('what reaches the upstream', () => {
  test('the model is replaced, never copied from the client', () => {
    const body = sanitizeAnthropicBody({ model: 'cc:claude-opus-5', messages: [] }, 'claude-opus-5');
    // The client names the gateway's public id; the upstream only knows its own.
    expect(body.model).toBe('claude-opus-5');
  });

  test('fields added to the API after this mapper was written still get through', () => {
    /**
     * The regression this exists to prevent. `thinking`, `output_config`, `context_management` and
     * `betas` all arrived after a mapper like this was first written; a narrow allowlist would strip
     * them and make a current client behave like an old one, silently.
     */
    const body = sanitizeAnthropicBody(
      {
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
        context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] },
        betas: ['compact-2026-01-12'],
        tools: [{ name: 't', description: 'd', input_schema: {} }],
        tool_choice: { type: 'auto' },
      },
      'claude-opus-5',
    );

    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'high' });
    expect(body.context_management).toEqual({ edits: [{ type: 'clear_tool_uses_20250919' }] });
    expect(body.betas).toEqual(['compact-2026-01-12']);
    expect(body.tools).toHaveLength(1);
  });

  test('a system prompt sent as cached blocks keeps its breakpoints', () => {
    // Normalising the two `system` forms into one would drop `cache_control` — turning a cached
    // prefix into an uncached one, which costs money and reports nothing.
    const body = sanitizeAnthropicBody(
      {
        messages: [],
        max_tokens: 10,
        system: [
          { type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'volatile' },
        ],
      },
      'claude-opus-5',
    );

    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  test('max_tokens is filled in, because the API refuses a request without it', () => {
    // The client was going to get a 400 either way; a default turns that into a working request.
    const body = sanitizeAnthropicBody({ messages: [] }, 'claude-opus-5');
    expect(body.max_tokens).toBe(4096);
  });

  test('a max_tokens the client did set is left alone', () => {
    const body = sanitizeAnthropicBody({ messages: [], max_tokens: 64_000 }, 'claude-opus-5');
    expect(body.max_tokens).toBe(64_000);
  });

  test('an unknown key is not forwarded', () => {
    // Generous is not unbounded: a client's own bookkeeping field is not Anthropic's business.
    const body = sanitizeAnthropicBody(
      { messages: [], max_tokens: 1, internalTraceId: 'abc' },
      'claude-opus-5',
    );
    expect('internalTraceId' in body).toBe(false);
  });
});
