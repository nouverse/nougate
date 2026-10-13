/**
 * How a client's thinking request becomes something Kiro acts on.
 *
 * Kiro has two mechanisms and which one a model gets is decided by the model, not the client:
 *
 *   - **Native effort fields** (`additionalModelRequestFields`). Claude 4.6+ take
 *     `output_config.effort` with adaptive thinking; GPT 5.6 takes `reasoning.effort`. Reasoning then
 *     arrives as `reasoningContentEvent` frames.
 *   - **The legacy prompt tag** (`<thinking_mode>enabled</thinking_mode>`), for everything else. The
 *     model then writes its reasoning inline, wrapped in `<thinking>…</thinking>`, and the stream
 *     mapper lifts it back out into a reasoning block.
 *
 * Every client vocabulary — Anthropic `thinking` / `output_config.effort`, OpenAI
 * `reasoning_effort` / `reasoning.effort`, the `anthropic-beta: interleaved-thinking` header, a
 * `<thinking_mode>` tag in the prompt, a `-thinking` model variant, or a `model(level)` suffix — is
 * reduced here to one budget (or `null` for "off") and one optional effort block.
 */

/** Budget used when thinking is requested without a size. */
export const KIRO_THINKING_BUDGET_DEFAULT = 16_000;

/** Kiro's own clamp on `<max_thinking_length>`. */
const KIRO_THINKING_BUDGET_MAX = 32_000;

export const LEVEL_TO_BUDGET: Readonly<Record<string, number>> = {
  none: 0,
  minimal: 512,
  low: 1024,
  medium: 8192,
  high: 24_576,
  xhigh: 32_768,
  max: 128_000,
};

/** A `model(level)` request override, consumed before the model id goes upstream. */
export type ThinkingOverride =
  | { mode: 'none' }
  | { mode: 'auto' }
  | { mode: 'budget'; budget: number }
  | { mode: 'level'; level: string };

type ThinkingIntent = ThinkingOverride;

export function parseThinkingSuffix(model: string): { cleanModel: string; override: ThinkingOverride | null } {
  const match = model.match(/^(.*)\(([^()]+)\)\s*$/);
  if (!match) return { cleanModel: model, override: null };
  const cleanModel = match[1]!.trim();
  const raw = match[2]!.trim().toLowerCase();
  if (raw === 'none' || raw === 'off') return { cleanModel, override: { mode: 'none' } };
  if (raw === 'auto') return { cleanModel, override: { mode: 'auto' } };
  if (raw === 'ultra') return { cleanModel, override: { mode: 'level', level: raw } };
  if (/^\d+$/.test(raw)) return { cleanModel, override: { mode: 'budget', budget: Number(raw) } };
  if (LEVEL_TO_BUDGET[raw] !== undefined) return { cleanModel, override: { mode: 'level', level: raw } };
  return { cleanModel, override: null };
}

/** Fold a `model(level)` override into the body, without mutating the caller's. */
export function applyThinkingOverride<T extends Record<string, any>>(body: T, override: ThinkingOverride | null): T {
  if (!override) return body;
  const next: Record<string, any> = { ...body };
  if (override.mode === 'budget') {
    delete next.output_config;
    delete next.reasoning_effort;
    delete next.reasoning;
    next.thinking = { type: 'enabled', budget_tokens: override.budget };
    return next as T;
  }
  next.output_config = {
    ...(body.output_config || {}),
    effort: override.mode === 'level' ? override.level : override.mode,
  };
  return next as T;
}

/** The thinking intent a body states, in any client's vocabulary, or `null` when it states none. */
export function extractThinkingIntent(body: any): ThinkingIntent | null {
  if (!body || typeof body !== 'object') return null;

  const outputEffort = body.output_config?.effort;
  if (typeof outputEffort === 'string' && outputEffort) return effortIntent(outputEffort);

  const effort = body.reasoning_effort ?? (typeof body.reasoning === 'object' ? body.reasoning?.effort : null);
  if (typeof effort === 'string' && effort) return effortIntent(effort);

  const thinking = body.thinking;
  if (thinking && typeof thinking === 'object') {
    if (thinking.type === 'disabled') return { mode: 'none' };
    if (thinking.type === 'adaptive' || thinking.type === 'enabled') {
      const budget = Number(thinking.budget_tokens);
      return Number.isFinite(budget) && budget > 0 ? { mode: 'budget', budget } : { mode: 'auto' };
    }
  }
  return null;
}

function effortIntent(value: string): ThinkingIntent {
  const effort = value.toLowerCase();
  if (effort === 'none' || effort === 'off') return { mode: 'none' };
  if (effort === 'auto') return { mode: 'auto' };
  return { mode: 'level', level: effort };
}

/**
 * The thinking budget to request, or `null` when thinking is off.
 *
 * An explicit "off" in the body wins over every softer signal, including the model's `-thinking`
 * suffix: a client that says no means no.
 */
export function resolveThinkingBudget(body: any, headers: Headers | null, model: string): number | null {
  const intent = extractThinkingIntent(body);
  if (intent) {
    if (intent.mode === 'none') return null;
    if (intent.mode === 'level' && intent.level === 'disabled') return null;
    if (intent.mode === 'budget') return intent.budget;
    if (intent.mode === 'level') {
      const budget = LEVEL_TO_BUDGET[intent.level];
      return budget === undefined || budget === 0 ? KIRO_THINKING_BUDGET_DEFAULT : budget;
    }
    return KIRO_THINKING_BUDGET_DEFAULT;
  }

  const beta = headers?.get('anthropic-beta');
  if (beta && beta.toLowerCase().includes('interleaved-thinking')) return KIRO_THINKING_BUDGET_DEFAULT;

  if (containsThinkingModeTag(body)) return KIRO_THINKING_BUDGET_DEFAULT;

  const lower = model.toLowerCase();
  if (lower.includes('thinking') || lower.includes('-reason')) return KIRO_THINKING_BUDGET_DEFAULT;

  return null;
}

/** The prompt prefix that turns inline reasoning on for models without native effort fields. */
export function buildThinkingSystemPrefix(budget: number = KIRO_THINKING_BUDGET_DEFAULT): string {
  const safe = Math.max(1, Math.min(KIRO_THINKING_BUDGET_MAX, Number(budget) || KIRO_THINKING_BUDGET_DEFAULT));
  return `<thinking_mode>enabled</thinking_mode>\n<max_thinking_length>${safe}</max_thinking_length>`;
}

function containsThinkingModeTag(body: any): boolean {
  const hasTag = (text: unknown) =>
    typeof text === 'string' &&
    (text.includes('<thinking_mode>enabled</thinking_mode>') ||
      text.includes('<thinking_mode>interleaved</thinking_mode>'));

  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (message?.role !== 'system' && message?.role !== 'user') continue;
    if (hasTag(message.content)) return true;
    if (Array.isArray(message.content) && message.content.some((part: any) => hasTag(part?.text))) return true;
  }
  if (hasTag(body?.system)) return true;
  if (Array.isArray(body?.system) && body.system.some((part: any) => hasTag(part?.text))) return true;
  return false;
}

// ─── Native effort fields ──────────────────────────────────────────────────

type EffortPath = 'output_config' | 'reasoning';

function parseClaudeVersion(model: string): { major: number; minor: number | null } | null {
  const normalized = model.toLowerCase().replace(/-/g, '.');
  const match = normalized.match(/(?:^|[/.])claude(?:[/.][a-z]+)*[/.](\d+)(?:[/.](\d+))?(?:[/.]|$)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: match[2] === undefined ? null : Number(match[2]) };
}

/**
 * Which effort schema a model accepts, or `null` for "use the prompt tag".
 *
 * Claude 4.5 and older rejected `additionalModelRequestFields` in live testing. Anything newer is
 * assumed to accept it, so a model released next month works without a code change.
 */
export function resolveEffortPath(model: string): EffortPath | null {
  const normalized = model.toLowerCase().replace(/-/g, '.');
  if (/(?:^|[/.])gpt[/.]5[/.]6(?:[/.]|$)/.test(normalized)) return 'reasoning';
  if (!normalized.includes('claude')) return null;
  const version = parseClaudeVersion(model);
  if (!version) return null;
  const { major, minor } = version;
  const dateSuffixMinor = minor !== null && minor >= 1000;
  return major < 4 || (major === 4 && (minor === null || minor <= 5 || dateSuffixMinor)) ? null : 'output_config';
}

function requestedEffort(body: any): string | null {
  const effort =
    body?.output_config?.effort ??
    body?.reasoning_effort ??
    (typeof body?.reasoning === 'object' ? body.reasoning?.effort : null);
  return typeof effort === 'string' ? effort.toLowerCase() : null;
}

/** 4.6 Claude models stop at `max`; `xhigh` arrived with 4.7. Unknown versions stay conservative. */
function lacksXhigh(model: string): boolean {
  const version = parseClaudeVersion(model);
  return !version || (version.major === 4 && version.minor !== null && version.minor <= 6);
}

export function claudeEffortLevel(body: any, model: string): string | null {
  const effort = requestedEffort(body);
  if (!effort || effort === 'none' || effort === 'off' || effort === 'disabled') return null;
  if (effort === 'xhigh') return lacksXhigh(model) ? 'high' : 'xhigh';
  if (effort === 'max') return 'max';
  return ['low', 'medium', 'high'].includes(effort) ? effort : null;
}

function gptEffortLevel(body: any): string | null {
  const effort = requestedEffort(body);
  if (effort === 'max') return 'xhigh';
  // Kiro CLI advertises no GPT "none" wire value; leave it off.
  return effort && ['low', 'medium', 'high', 'xhigh'].includes(effort) ? effort : null;
}

/** `additionalModelRequestFields` for this model and body, or `undefined` when none apply. */
export function buildAdditionalModelRequestFields(body: any, model: string): Record<string, unknown> | undefined {
  const path = resolveEffortPath(model);
  if (path === 'reasoning') {
    const effort = gptEffortLevel(body);
    return effort ? { reasoning: { effort } } : undefined;
  }
  if (path === 'output_config') {
    const effort = claudeEffortLevel(body, model);
    return effort
      ? { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort } }
      : undefined;
  }
  return undefined;
}

/** GPT models with a native effort get no prompt tag on top — it would be read as user text. */
export function usesNativeGptEffort(body: any, model: string): boolean {
  return resolveEffortPath(model) === 'reasoning' && gptEffortLevel(body) !== null;
}
