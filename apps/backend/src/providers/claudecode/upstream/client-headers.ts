/**
 * Claude CLI identity headers — User-Agent and the X-Stainless-* platform suite.
 *
 * Applied when the credential is OAuth to align with Claude CLI protocol expectations.
 */

import { CLAUDE_CLI_VERSION } from '../config/constants';

// ---------------------------------------------------------------------------
// Stainless OS/Arch fingerprint — maps the host to the strings the real SDK emits.
// Bun exposes `process.platform` and `process.arch` globally, no `node:os` needed.
// ---------------------------------------------------------------------------

export function mapStainlessOs(): string {
  switch (process.platform) {
    case 'darwin': return 'MacOS';
    case 'win32': return 'Windows';
    case 'linux': return 'Linux';
    case 'freebsd': return 'FreeBSD';
    default: return `Other::${process.platform}`;
  }
}

export function mapStainlessArch(): string {
  switch (process.arch) {
    case 'x64': return 'x64';
    case 'arm64': return 'arm64';
    case 'ia32': return 'x86';
    default: return `other::${process.arch}`;
  }
}

/**
 * The full set of headers for a `claude-cli` session.
 *
 * Evaluated once at module load — the OS and arch do not change at runtime.
 */
export const CLAUDE_CLI_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent': `claude-cli/${CLAUDE_CLI_VERSION} (external, sdk-cli)`,
  'Anthropic-Dangerous-Direct-Browser-Access': 'true',
  'X-App': 'cli',
  'X-Stainless-Helper-Method': 'stream',
  'X-Stainless-Retry-Count': '0',
  'X-Stainless-Runtime-Version': 'v24.14.0',
  'X-Stainless-Package-Version': '0.80.0',
  'X-Stainless-Runtime': 'node',
  'X-Stainless-Lang': 'js',
  'X-Stainless-Arch': mapStainlessArch(),
  'X-Stainless-Os': mapStainlessOs(),
  'X-Stainless-Timeout': '600',
};

// ---------------------------------------------------------------------------
// Model-dependent beta string
// ---------------------------------------------------------------------------

const ANTHROPIC_BETA_BASE = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'structured-outputs-2025-12-15',
  'fast-mode-2026-02-01',
  'redact-thinking-2026-02-12',
  'token-efficient-tools-2026-03-28',
];

const ANTHROPIC_BETA_HEAVY_AGENT = ['advanced-tool-use-2025-11-20', 'effort-2025-11-24'];

/**
 * Assemble the `anthropic-beta` value for a given model.
 *
 * Heavy-agent flags (`advanced-tool-use`, `effort`) are gated to opus/sonnet — cheaper models
 * do not need them, and sending them on a model that does not support them is harmless but noisy.
 */
export function selectAnthropicBeta(model: string = ''): string {
  const flags = [...ANTHROPIC_BETA_BASE];
  if (/^claude-(opus|sonnet)/.test(model)) flags.push(...ANTHROPIC_BETA_HEAVY_AGENT);
  return flags.join(',');
}
