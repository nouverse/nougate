/**
 * The models an upstream lists itself, laid over a provider's written ones (`core/live-models.ts`).
 *
 * Each provider's model list was written by hand and went stale the day its upstream added a model:
 * Codex did not offer `gpt-6-luna`. Each provider now asks its upstream at start, after an account is
 * added and every six hours. The written specs keep their checked facts; a failed fetch keeps the last
 * list; and the timer runs inside Nouride's process, where an exception that escapes it ends the
 * daemon — so the timer is proven in a process of its own.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IModelSpec } from '@/core/interfaces';
import { fetchModelList, LayeredModelRegistry, LIVE_MODELS_REFRESH_MS, LiveModelList } from '@/core/live-models';

const BACKEND = join(import.meta.dir, '..', '..');
const realFetch = globalThis.fetch;
const realLog = console.log;
const realWarn = console.warn;

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.warn = realWarn;
});

function spec(modelId: string, displayName = modelId, extra: Partial<IModelSpec> = {}): IModelSpec {
  return { modelId, displayName, pool: 'cli', isThinking: false, maxOutputTokens: 8192, ...extra };
}

/** Every line `console.log` and `console.warn` print while `run` runs. */
async function logged(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  console.warn = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    await run();
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }
  return lines;
}

describe('the layered registry', () => {
  test('a written model keeps its own facts, and one only the upstream lists is added', () => {
    const registry = new LayeredModelRegistry({
      written: { known: spec('known', 'Known (written)', { inputPricePer1M: 5, maxOutputTokens: 64_000 }) },
    });

    const added = registry.mergeLive([spec('known', 'Known (live)', { maxOutputTokens: 1 }), spec('fresh', 'Fresh')]);

    expect(added).toBe(1);
    expect(registry.listModelIds()).toEqual(['fresh', 'known']);
    expect(registry.getSpec('known')).toMatchObject({ displayName: 'Known (written)', inputPricePer1M: 5, maxOutputTokens: 64_000 });
    expect(registry.getSpec('fresh')).toMatchObject({ modelId: 'fresh', displayName: 'Fresh' });
    expect(registry.liveModelIds()).toEqual(['fresh']);
  });

  test("each answer replaces the upstream's set whole, and the written list stays", () => {
    const registry = new LayeredModelRegistry({ written: { known: spec('known') } });
    registry.mergeLive([spec('first')]);
    registry.mergeLive([spec('second')]);

    expect(registry.listModelIds()).toEqual(['known', 'second']);
    expect(registry.getSpec('first')).toBeNull();

    registry.mergeLive([]);
    expect(registry.listModelIds()).toEqual(['known']);
  });

  test("a model is one entry under the provider's spelling rule, whichever spelling the upstream used", () => {
    const registry = new LayeredModelRegistry({
      written: { 'model-1-5': spec('model-1-5', 'Written') },
      key: (id) => id.trim().toLowerCase().replace(/\./g, '-'),
    });

    expect(registry.mergeLive([spec('Model-1.5'), spec('NEW.2'), spec('new-2')])).toBe(1);
    expect(registry.listModelIds()).toEqual(['model-1-5', 'new-2']);
    expect(registry.getSpec('model-1.5')?.displayName).toBe('Written');
    expect(registry.getSpec('NEW-2')?.modelId).toBe('new-2');
  });

  test('an id neither list has goes to the provider’s own answer, and only then', () => {
    const asked: string[] = [];
    const registry = new LayeredModelRegistry({
      written: { known: spec('known') },
      unknown: (id) => {
        asked.push(id);
        return null;
      },
    });
    registry.mergeLive([spec('fresh')]);

    expect(registry.getSpec('known')).not.toBeNull();
    expect(registry.getSpec('fresh')).not.toBeNull();
    expect(registry.getSpec('nowhere')).toBeNull();
    expect(asked).toEqual(['nowhere']);
  });

  test('what a lookup hands out is a copy', () => {
    const registry = new LayeredModelRegistry({ written: { known: spec('known', 'Known') } });
    registry.getSpec('known')!.displayName = 'edited';
    expect(registry.getSpec('known')?.displayName).toBe('Known');
  });
});

describe('a live model list', () => {
  function listOver(registry: LayeredModelRegistry, fetch: () => Promise<IModelSpec[] | null>) {
    return new LiveModelList({ provider: 'test', fetch, merge: (specs) => registry.mergeLive(specs) });
  }

  test('an answer is laid over the written list, and the log names the provider and the count added', async () => {
    const registry = new LayeredModelRegistry({ written: { known: spec('known') } });
    const lines = await logged(() => listOver(registry, async () => [spec('known'), spec('fresh')]).refresh());

    expect(registry.listModelIds()).toEqual(['fresh', 'known']);
    expect(lines).toEqual(['[test] live model list: 2 offered, 1 added']);
  });

  test('a failed fetch keeps the last list, and the log says the status, not the body', async () => {
    const registry = new LayeredModelRegistry({ written: { known: spec('known') } });
    let answer: () => Promise<IModelSpec[] | null> = async () => [spec('fresh')];
    const list = listOver(registry, () => answer());
    await logged(() => list.refresh());

    answer = async () => {
      throw Object.assign(new Error('upstream said: Bearer abc.def is not welcome'), { status: 503 });
    };
    const lines = await logged(() => list.refresh());

    expect(registry.listModelIds()).toEqual(['fresh', 'known']);
    expect(lines).toEqual(['[test] could not read the live model list (HTTP 503); the last one stays']);
  });

  test('nobody to ask changes nothing and says nothing', async () => {
    const registry = new LayeredModelRegistry({ written: {} });
    registry.mergeLive([spec('fresh')]);
    const lines = await logged(() => listOver(registry, async () => null).refresh());

    expect(registry.listModelIds()).toEqual(['fresh']);
    expect(lines).toEqual([]);
  });

  test('a refresh asked for while one runs joins it', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const list = listOver(new LayeredModelRegistry({ written: {} }), async () => {
      calls += 1;
      await gate;
      return [];
    });

    const done = logged(async () => {
      const first = list.refresh();
      const second = list.refresh();
      release();
      await Promise.all([first, second]);
    });
    await done;
    expect(calls).toBe(1);
  });

  test('started, it asks at once and again on its interval, until stopped', async () => {
    let calls = 0;
    const list = listOver(new LayeredModelRegistry({ written: {} }), async () => {
      calls += 1;
      return [];
    });

    await logged(async () => {
      list.start(20);
      list.start(20);
      await Bun.sleep(70);
      list.stop();
    });
    const atStop = calls;
    await Bun.sleep(30);

    // One at start and roughly one per interval after; a second start adds no second timer.
    expect(atStop).toBeGreaterThanOrEqual(2);
    expect(atStop).toBeLessThanOrEqual(5);
    expect(calls).toBe(atStop);
  });
});

describe('every six hours, for every provider', () => {
  test('a list started without an interval asks again every six hours', async () => {
    const realSetInterval = globalThis.setInterval;
    const intervals: number[] = [];
    globalThis.setInterval = ((handler: () => void, ms: number) => {
      intervals.push(ms);
      return realSetInterval(handler, ms);
    }) as typeof setInterval;
    const list = new LiveModelList({ provider: 'test', fetch: async () => null, merge: () => 0 });
    try {
      list.start();
    } finally {
      list.stop();
      globalThis.setInterval = realSetInterval;
    }

    expect(LIVE_MODELS_REFRESH_MS).toBe(6 * 60 * 60 * 1000);
    expect(intervals).toEqual([LIVE_MODELS_REFRESH_MS]);
  });

  // Starting a provider for real loads its accounts from files fixed when their modules load, and would
  // ask a real upstream with them; so what `init()` does is read, not run.
  test.each([
    ['kiro', 'kiroModelList'],
    ['codex', 'codexModelList'],
    ['claudecode', 'claudeCodeModelList'],
  ])('%s starts its list when it starts', (provider, list) => {
    const source = readFileSync(join(BACKEND, 'src', 'providers', provider, 'index.ts'), 'utf8');
    const start = source.indexOf('async init(): Promise<void> {');
    const init = source.slice(start, source.indexOf('\n  }\n', start));
    expect(start).toBeGreaterThan(0);
    expect(init).toContain(`${list}.start();`);
  });
});

describe('the timer, in a process of its own', () => {
  /** Run `code` as its own Bun process from the backend's root, so `@/` resolves. */
  async function run(code: string): Promise<{ exitCode: number; stdout: string; stderr: string; ms: number }> {
    const started = Date.now();
    const child = Bun.spawn([process.execPath, '-e', code], { cwd: BACKEND, stdout: 'pipe', stderr: 'pipe' });
    const killer = setTimeout(() => child.kill(), 5_000);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(killer);
    return { exitCode, stdout, stderr, ms: Date.now() - started };
  }

  test('a fetch that throws, or rejects, every time leaves the process up', async () => {
    const result = await run(`
      import { LiveModelList } from '@/core/live-models';
      const rejects = new LiveModelList({ provider: 'rejects', fetch: async () => { throw new Error('upstream down'); }, merge: () => 0 });
      const throws = new LiveModelList({ provider: 'throws', fetch: () => { throw new Error('thrown at once'); }, merge: () => 0 });
      const badMerge = new LiveModelList({ provider: 'merge', fetch: async () => [], merge: () => { throw new Error('merge broke'); } });
      rejects.start(5); throws.start(5); badMerge.start(5);
      setTimeout(() => { console.log('alive'); process.exit(0); }, 150);
    `);

    expect(result.stdout.trim()).toBe('alive');
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('[rejects] could not read the live model list (upstream down)');
    expect(result.stderr).toContain('[throws] could not read the live model list (thrown at once)');
    expect(result.stderr).toContain('[merge] could not read the live model list (merge broke)');
  });

  test('the timer does not hold the process open', async () => {
    const result = await run(`
      import { LiveModelList } from '@/core/live-models';
      new LiveModelList({ provider: 'idle', fetch: async () => null, merge: () => 0 }).start();
    `);

    expect(result.exitCode).toBe(0);
    expect(result.ms).toBeLessThan(4_000);
  });
});

describe('fetchModelList', () => {
  test('a GET, and an answer that is not 2xx throws its status and none of its body', async () => {
    const seen: Array<{ url: string; method?: string; auth: string | null }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), method: init?.method, auth: new Headers(init?.headers).get('authorization') });
      return new Response('{"error":"token sk-secret-value is expired"}', { status: 401 });
    }) as typeof fetch;

    const error = await fetchModelList('https://upstream.test/models', { authorization: 'Bearer test-token' }).catch((e: unknown) => e);

    expect(seen).toEqual([{ url: 'https://upstream.test/models', method: 'GET', auth: 'Bearer test-token' }]);
    expect(error).toMatchObject({ status: 401 });
    expect(String((error as Error).message)).not.toContain('sk-secret-value');
  });

  test('a 2xx answer is its JSON', async () => {
    globalThis.fetch = (async () => Response.json({ data: [{ id: 'm' }] })) as unknown as typeof fetch;
    expect(await fetchModelList('https://upstream.test/models', {})).toEqual({ data: [{ id: 'm' }] });
  });
});
