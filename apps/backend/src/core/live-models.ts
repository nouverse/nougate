/**
 * A provider's models are the ones its upstream lists.
 *
 * ## Why
 *
 * Each provider's model list used to be written by hand, and it went stale the day its upstream added
 * a model: ChatGPT offered `gpt-6-luna` through Codex while the gateway did not list it, so no client
 * could pick it. Now each provider asks its upstream which models it offers — at start, after an
 * account is added, and every six hours — and that answer is its list. No id list is written down.
 *
 * ## What is kept, and where
 *
 * The last good answer is kept on disk, beside the provider's other state, and read back at start: a
 * restart or an upstream outage never empties a picker. A failed fetch changes nothing, and neither
 * does an answer that lists no model at all, once there is a list to lose. Before any answer and with
 * no file, a provider lists nothing; an install with no account could not use a model anyway.
 *
 * Facts an upstream does not state stay in each provider, keyed by what they are about (a default
 * output limit, a family that takes thinking variants), never as a list of which models exist. An
 * operator's own specs, where a provider reads an override file, still win over the upstream's.
 *
 * Lookups read memory: nothing on the request path waits on the network.
 */

import type { IModelRegistry, IModelSpec } from '@/core/interfaces';
import { dataPath } from '@/core/paths';
import { writeJsonAtomic } from '@/core/state-file';

/**
 * How often each provider asks its upstream again — an estimate. Upstreams add models every few
 * weeks, so a model six hours late is not missed, and four calls a day per provider cost nothing.
 */
export const LIVE_MODELS_REFRESH_MS = 6 * 60 * 60 * 1000;

/** Long enough for a slow upstream, short enough that a hung one does not hold a refresh for good. */
const LIST_TIMEOUT_MS = 30_000;

export interface LayeredModelRegistryOptions {
  /**
   * An operator's own changes, from a provider's override file, by the key it looks them up by. Laid
   * over the upstream's spec of that model; read on every lookup, so a file loaded into the same
   * object later counts.
   */
  overrides?: Record<string, Partial<IModelSpec>>;
  /**
   * A whole spec made of an override that names a model the upstream does not list: the operator
   * asked for it to exist. Without this, such an override changes nothing.
   */
  complete?: (modelId: string, override: Partial<IModelSpec>) => IModelSpec;
  /** The key an id is looked up by: the provider's own spelling rule. The id itself when absent. */
  key?: (modelId: string) => string;
  /** The answer for an id no list has: a provider's `bypassModelValidation` path. */
  unknown?: (modelId: string) => IModelSpec | null;
}

/** The upstream's specs, with an operator's own changes laid over them where it wrote some. */
export class LayeredModelRegistry implements IModelRegistry {
  private live = new Map<string, IModelSpec>();

  constructor(private readonly options: LayeredModelRegistryOptions = {}) {}

  private keyOf(modelId: string): string {
    return this.options.key ? this.options.key(modelId) : modelId;
  }

  /** The overrides that make a model exist: ones naming a model the upstream does not list. */
  private standalone(): string[] {
    const { overrides, complete } = this.options;
    if (!overrides || !complete) return [];
    return Object.keys(overrides).filter((key) => !this.live.has(key));
  }

  /** A copy: a caller that edits what it was handed must not edit the registry. */
  getSpec(modelId: string): IModelSpec | null {
    const key = this.keyOf(modelId);
    const override = this.options.overrides?.[key];
    const live = this.live.get(key);
    if (live) return override ? { ...live, ...override, modelId: key } : { ...live };
    if (override && this.options.complete) return this.options.complete(key, override);
    return this.options.unknown ? this.options.unknown(modelId) : null;
  }

  listModelIds(): string[] {
    return [...new Set([...this.live.keys(), ...this.standalone()])].sort();
  }

  /** The ids the upstream lists. */
  liveModelIds(): string[] {
    return [...this.live.keys()].sort();
  }

  /** Replace the upstream's set with `specs`, one per key. Returns how many it holds. */
  mergeLive(specs: IModelSpec[]): number {
    const next = new Map<string, IModelSpec>();
    for (const spec of specs) {
      const key = this.keyOf(spec.modelId);
      if (next.has(key)) continue;
      next.set(key, { ...spec, modelId: key });
    }
    this.live = next;
    return next.size;
  }
}

export interface LiveModelSource<T> {
  /** The provider's id: names it in the log, and its folder for the file the last answer is kept in. */
  provider: string;
  /**
   * What the upstream offers now, or `null` when there is nobody to ask: no account, or the
   * provider switched it off. Throws when the fetch fails.
   */
  fetch: () => Promise<T[] | null>;
  /** Make these the provider's models; returns how many it lists. */
  merge: (entries: T[]) => number;
}

/** The file one provider's last good answer is kept in. Resolved per call, as every state path is. */
export function modelListFile(provider: string): string {
  return dataPath('providers', provider, 'models.json');
}

interface SavedModelList<T> {
  savedAt: string;
  models: T[];
}

/**
 * One provider's model list: read back from disk at start, asked for then, and again on a timer.
 *
 * Never throws and never rejects. Nougate runs inside Nouride's own process, and an exception that
 * escapes a timer there ends the daemon, not one refresh.
 */
export class LiveModelList<T> {
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** How many models the list holds now, from disk or from the upstream. */
  private held = 0;
  /** Whether the upstream has answered since start: a file read after that would be older. */
  private answered = false;

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
      // An outage can look like an answer with nothing in it. Emptying a picker on that would be worse
      // than keeping a list a few hours old, so an empty answer replaces only an empty list.
      if (entries.length === 0 && this.held > 0) {
        console.warn(`[${provider}] the upstream listed no models; the last list (${this.held}) stays`);
        return;
      }
      this.held = this.source.merge(entries);
      this.answered = true;
      console.log(`[${provider}] model list from the upstream: ${this.held} model(s)`);
      this.save(entries);
    } catch (error) {
      console.warn(`[${provider}] could not read the model list (${failureOf(error)}); the last one stays`);
    }
  }

  /** Keep this answer for the next start. A failed write costs the next start its list, not this one. */
  private save(entries: T[]): void {
    try {
      const saved: SavedModelList<T> = { savedAt: new Date().toISOString(), models: entries };
      writeJsonAtomic(modelListFile(this.source.provider), saved);
    } catch (error) {
      console.warn(`[${this.source.provider}] could not keep the model list on disk: ${failureOf(error)}`);
    }
  }

  /** The last good answer, from disk, unless the upstream has answered since. */
  async restore(): Promise<void> {
    const { provider } = this.source;
    try {
      const file = Bun.file(modelListFile(provider));
      if (!(await file.exists())) return;
      const saved = (await file.json()) as Partial<SavedModelList<T>> | null;
      if (!Array.isArray(saved?.models)) throw new Error('the file holds no `models` list');
      if (this.answered) return;
      this.held = this.source.merge(saved.models);
      console.log(`[${provider}] model list from disk: ${this.held} model(s), kept ${saved.savedAt ?? 'at an unknown time'}`);
    } catch (error) {
      console.warn(`[${provider}] could not read the kept model list (${failureOf(error)}); the upstream's answer will be the list`);
    }
  }

  /**
   * Read the kept list back, then ask now and every `intervalMs`. Resolves once the kept list is in,
   * so a provider's start can wait for it; the asking goes on in the background. The timer is
   * unref'd: a model list is not worth holding a process open for. A second call does nothing.
   */
  async start(intervalMs: number = LIVE_MODELS_REFRESH_MS): Promise<void> {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        void this.refresh();
      } catch (error) {
        console.warn(`[${this.source.provider}] the model list timer failed: ${failureOf(error)}`);
      }
    }, intervalMs);
    this.timer.unref?.();
    await this.restore();
    void this.refresh();
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
