/**
 * The models an upstream lists itself, laid over the ones a provider writes down.
 *
 * ## Why
 *
 * Each provider's model list was written by hand, and it went stale the day its upstream added a
 * model: ChatGPT offered `gpt-6-luna` through Codex while the gateway did not list it, so no client
 * could pick it. So each provider asks its upstream which models it offers — at start, after an
 * account is added, and every six hours — and lists those its own list lacks.
 *
 * ## Two lists, one lookup
 *
 * The written specs are always there and always win: they carry facts someone checked (a price, an
 * output limit, the id the upstream is really sent) that a model list does not state. A model only
 * the upstream lists is added with what its list says and the provider's defaults for the rest,
 * unpriced. The upstream's set is replaced whole on each answer, so a model it stops listing stops
 * being offered, unless the written list has it.
 *
 * Lookups read memory: nothing on the request path waits on the network. A fetch that fails changes
 * nothing, and the last list stays.
 */

import type { IModelRegistry, IModelSpec } from '@/core/interfaces';

/**
 * How often each provider asks its upstream again — an estimate. Upstreams add models every few
 * weeks, so a model six hours late is not missed, and four calls a day per provider cost nothing.
 */
export const LIVE_MODELS_REFRESH_MS = 6 * 60 * 60 * 1000;

/** Long enough for a slow upstream, short enough that a hung one does not hold a refresh for good. */
const LIST_TIMEOUT_MS = 30_000;

export interface LayeredModelRegistryOptions {
  /**
   * The provider's written specs, by the key it looks them up by. Read on every lookup, so an
   * override file loaded into the same object later counts.
   */
  written: Record<string, IModelSpec>;
  /** The key an id is looked up by: the provider's own spelling rule. The id itself when absent. */
  key?: (modelId: string) => string;
  /** The answer for an id neither list has: a provider's `bypassModelValidation` path. */
  unknown?: (modelId: string) => IModelSpec | null;
}

/** The written specs, and the upstream's own on top of them where the written ones say nothing. */
export class LayeredModelRegistry implements IModelRegistry {
  private live = new Map<string, IModelSpec>();

  constructor(private readonly options: LayeredModelRegistryOptions) {}

  private keyOf(modelId: string): string {
    return this.options.key ? this.options.key(modelId) : modelId;
  }

  /** A copy: a caller that edits what it was handed must not edit the registry. */
  getSpec(modelId: string): IModelSpec | null {
    const key = this.keyOf(modelId);
    const spec = this.options.written[key] ?? this.live.get(key);
    if (spec) return { ...spec };
    return this.options.unknown ? this.options.unknown(modelId) : null;
  }

  listModelIds(): string[] {
    return [...new Set([...Object.keys(this.options.written), ...this.live.keys()])].sort();
  }

  /** The ids only the upstream lists. */
  liveModelIds(): string[] {
    return [...this.live.keys()].sort();
  }

  /**
   * Replace the upstream's set with `specs`, leaving out each one the written list has under the
   * same key. Returns how many it added.
   */
  mergeLive(specs: IModelSpec[]): number {
    const next = new Map<string, IModelSpec>();
    for (const spec of specs) {
      const key = this.keyOf(spec.modelId);
      if (Object.hasOwn(this.options.written, key) || next.has(key)) continue;
      next.set(key, { ...spec, modelId: key });
    }
    this.live = next;
    return next.size;
  }
}

export interface LiveModelSource<T> {
  /** The provider's id, for the log. */
  provider: string;
  /**
   * What the upstream offers now, or `null` when there is nobody to ask: no account, or the
   * provider switched it off. Throws when the fetch fails.
   */
  fetch: () => Promise<T[] | null>;
  /** Lay them over the written list; returns how many were added. */
  merge: (entries: T[]) => number;
}

/**
 * One provider's live model list: asked for now, and again on a timer.
 *
 * Never throws and never rejects. Nougate runs inside Nouride's own process, and an exception that
 * escapes a timer there ends the daemon, not one refresh.
 */
export class LiveModelList<T> {
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly source: LiveModelSource<T>) {}

  /** Ask the upstream now. A call while one is running joins it rather than asking twice. */
  refresh(): Promise<void> {
    if (!this.running) {
      this.running = this.ask().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async ask(): Promise<void> {
    const { provider } = this.source;
    try {
      const entries = await this.source.fetch();
      if (!entries) return;
      const added = this.source.merge(entries);
      console.log(`[${provider}] live model list: ${entries.length} offered, ${added} added`);
    } catch (error) {
      console.warn(`[${provider}] could not read the live model list (${failureOf(error)}); the last one stays`);
    }
  }

  /**
   * Ask now, then every `intervalMs`. The timer is unref'd: a model list is not worth holding a
   * process open for. A second call while the timer runs does nothing.
   */
  start(intervalMs: number = LIVE_MODELS_REFRESH_MS): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => {
      try {
        void this.refresh();
      } catch (error) {
        console.warn(`[${this.source.provider}] the live model list timer failed: ${failureOf(error)}`);
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * What a failure is, for the log: the HTTP status when it has one, the message otherwise. Never a
 * response body, which is the upstream's to word.
 */
function failureOf(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return `HTTP ${status}`;
  return error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
}

/** A model list that answered with something other than 2xx. Carries its status and nothing of its body. */
class ModelListError extends Error {
  constructor(readonly status: number) {
    super(`the model list answered HTTP ${status}`);
    this.name = 'ModelListError';
  }
}

/** GET an upstream's model list as JSON. */
export async function fetchModelList(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ModelListError(response.status);
  }
  return response.json();
}

/** A token count an upstream stated: a positive whole number, or nothing. */
export function statedTokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}
