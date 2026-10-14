/**
 * Claude CLI headers — User-Agent, X-Stainless-* platform suite, and model-aware beta selection.
 */

import { describe, expect, test } from 'bun:test';
import {
  CLAUDE_CLI_HEADERS,
  mapStainlessArch,
  mapStainlessOs,
  selectAnthropicBeta,
} from '@/providers/claudecode/upstream/client-headers';

describe('CLAUDE_CLI_HEADERS', () => {
  test('User-Agent matches claude-cli/<version> pattern', () => {
    expect(CLAUDE_CLI_HEADERS['User-Agent']).toMatch(/^claude-cli\/\d+\.\d+\.\d+ \(external, sdk-cli\)$/);
  });

  test('contains all X-Stainless-* headers', () => {
    expect(CLAUDE_CLI_HEADERS['X-Stainless-Lang']).toBe('js');
    expect(CLAUDE_CLI_HEADERS['X-Stainless-Runtime']).toBe('node');
    expect(CLAUDE_CLI_HEADERS['X-Stainless-Retry-Count']).toBe('0');
    expect(CLAUDE_CLI_HEADERS['X-Stainless-Timeout']).toBe('600');
    expect(CLAUDE_CLI_HEADERS['X-Stainless-Helper-Method']).toBe('stream');
  });

  test('X-App is set to cli', () => {
    expect(CLAUDE_CLI_HEADERS['X-App']).toBe('cli');
  });
});

describe('mapStainlessOs', () => {
  test('returns a non-empty string', () => {
    const result = mapStainlessOs();
    expect(result.length).toBeGreaterThan(0);
  });

  test('result is one of the known values or Other::<platform>', () => {
    const known = ['MacOS', 'Windows', 'Linux', 'FreeBSD'];
    const result = mapStainlessOs();
    expect(known.includes(result) || result.startsWith('Other::')).toBe(true);
  });
});

describe('mapStainlessArch', () => {
  test('returns a non-empty string', () => {
    const result = mapStainlessArch();
    expect(result.length).toBeGreaterThan(0);
  });

  test('result is one of the known values or other::<arch>', () => {
    const known = ['x64', 'arm64', 'x86'];
    const result = mapStainlessArch();
    expect(known.includes(result) || result.startsWith('other::')).toBe(true);
  });
});

describe('selectAnthropicBeta', () => {
  test('includes base flags for any model', () => {
    const beta = selectAnthropicBeta('claude-haiku-3-20240307');
    expect(beta).toContain('claude-code-20250219');
    expect(beta).toContain('interleaved-thinking-2025-05-14');
    expect(beta).toContain('token-efficient-tools-2026-03-28');
  });

  test('includes heavy-agent flags for opus', () => {
    const beta = selectAnthropicBeta('claude-opus-4-20250514');
    expect(beta).toContain('advanced-tool-use-2025-11-20');
    expect(beta).toContain('effort-2025-11-24');
  });

  test('includes heavy-agent flags for sonnet', () => {
    const beta = selectAnthropicBeta('claude-sonnet-4-20250514');
    expect(beta).toContain('advanced-tool-use-2025-11-20');
    expect(beta).toContain('effort-2025-11-24');
  });

  test('excludes heavy-agent flags for non-opus/sonnet models', () => {
    const beta = selectAnthropicBeta('claude-haiku-3-20240307');
    expect(beta).not.toContain('advanced-tool-use-2025-11-20');
    expect(beta).not.toContain('effort-2025-11-24');
  });

  test('handles empty model string', () => {
    const beta = selectAnthropicBeta('');
    expect(beta).toContain('claude-code-20250219');
    expect(beta).not.toContain('advanced-tool-use');
  });
});
