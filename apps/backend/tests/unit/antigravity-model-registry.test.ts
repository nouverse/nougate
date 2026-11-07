/**
 * Antigravity's Gemini 3.8 Flash — Google serves the thinking level as its own ids (low, medium,
 * high). A budget sent with a level id would override the level it names; the bare
 * `gemini-3.8-flash` is not an upstream id and goes to Medium.
 */

import { describe, expect, test } from 'bun:test';
import { antigravityModelRegistry } from '@/providers/antigravity/config/model-specs';

describe('Antigravity Gemini 3.8 Flash', () => {
  test('low, medium and high are offered', () => {
    const ids = antigravityModelRegistry.listModelIds();
    expect(ids).toEqual(expect.arrayContaining(['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high']));
  });

  test('the bare gemini-3.8-flash goes to Medium, never to tiered', () => {
    const spec = antigravityModelRegistry.getSpec('gemini-3.8-flash')!;
    expect(spec.upstreamModelId).toBe('gemini-3.8-flash-medium');
    expect(spec.thinkingBudget).toBeUndefined();
  });

  for (const level of ['low', 'medium', 'high']) {
    test(`${level} goes to Google under its own id, with no budget of ours`, () => {
      const spec = antigravityModelRegistry.getSpec(`gemini-3.8-flash-${level}`)!;
      expect(spec.upstreamModelId ?? spec.modelId).toBe(`gemini-3.8-flash-${level}`);
      expect(spec.thinkingBudget).toBeUndefined();
      expect(spec.isThinking).toBe(true);
    });
  }

  test('the other models Google offers now are listed', () => {
    expect(antigravityModelRegistry.listModelIds()).toEqual(
      expect.arrayContaining(['gemini-3-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-pro']),
    );
  });
});

describe('Antigravity Claude 5.5', () => {
  for (const id of ['claude-sonnet-5-5-low', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-high',
    'claude-opus-5-5-low', 'claude-opus-5-5-medium', 'claude-opus-5-5-high']) {
    test(`${id} goes to Google under its own id, thinking, with no budget of ours`, () => {
      const spec = antigravityModelRegistry.getSpec(id)!;
      expect(spec.upstreamModelId ?? spec.modelId).toBe(id);
      expect(spec.isThinking).toBe(true);
      expect(spec.thinkingBudget).toBeUndefined();
      expect(spec.maxOutputTokens).toBe(128000);
    });
  }
});
