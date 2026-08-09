import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// The config manager writes on update, so point it at a scratch file rather
// than the developer's real data/config.json.
const tempDir = mkdtempSync(join(tmpdir(), 'nougate-compression-'));
process.env.CONFIG_FILE = join(tempDir, 'config.json');

const { loadProxyConfig, updateProxyConfig, getProxyConfig } = await import('@/config/manager');
const { prepareRequestPayload } = await import('@/core/metrics/compression');

/**
 * A tool-heavy payload: RTK's whole job is collapsing this kind of output, so
 * it gives the pipeline something real to compress rather than asserting
 * against a no-op.
 */
function toolHeavyBody() {
  const noisyDiff = Array.from(
    { length: 200 },
    (_, index) => ` unchanged context line ${index} that a diff repeats verbatim`,
  ).join('\n');

  return {
    model: 'test:model',
    messages: [
      { role: 'user', content: 'summarise the diff' },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: `diff --git a/x b/x\n${noisyDiff}\n+added line\n`,
      },
    ],
  };
}

beforeAll(async () => {
  await loadProxyConfig();
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.CONFIG_FILE;
});

describe('compression attribution', () => {
  test('attributes savings to the engine that produced them', async () => {
    await updateProxyConfig({
      rtk: { enabled: true },
      headroom: { ...getProxyConfig().headroom, enabled: false },
    });

    const { compression } = await prepareRequestPayload(toolHeavyBody());

    expect(compression.byEngine.map((entry) => entry.engine)).toEqual(['rtk']);
    expect(compression.byEngine[0].tokensSaved).toBeGreaterThan(0);
    // Without attribution the dashboard could only ever show one total, which
    // cannot answer "is RTK earning its place?".
    expect(compression.tokensSaved).toBe(compression.byEngine[0].tokensSaved);
  });

  test('the breakdown always adds up to the headline figure', async () => {
    const { compression } = await prepareRequestPayload(toolHeavyBody());
    const summed = compression.byEngine.reduce((total, entry) => total + entry.tokensSaved, 0);

    // A remainder here would show up in the dashboard as savings nothing claims.
    expect(compression.tokensSaved).toBe(summed);
  });

  test('an engine that is switched off is absent, not zero', async () => {
    await updateProxyConfig({
      rtk: { enabled: false },
      headroom: { ...getProxyConfig().headroom, enabled: false },
    });

    const { compression } = await prepareRequestPayload(toolHeavyBody());

    // "Off" and "on but saved nothing" are different facts; reporting both as 0
    // would hide a filter that has stopped matching anything.
    expect(compression.byEngine).toEqual([]);
    expect(compression.tokensSaved).toBe(0);
  });

  test('an engine that ran and saved nothing is still reported', async () => {
    await updateProxyConfig({
      rtk: { enabled: true },
      headroom: { ...getProxyConfig().headroom, enabled: false },
    });

    // No tool output at all, so RTK has nothing to collapse.
    const { compression } = await prepareRequestPayload({
      model: 'test:model',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(compression.byEngine).toEqual([{ engine: 'rtk', tokensSaved: 0 }]);
  });

  test('leaves the payload usable, not just smaller', async () => {
    await updateProxyConfig({ rtk: { enabled: true } });

    const { body } = await prepareRequestPayload(toolHeavyBody());

    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages).toHaveLength(2);
    expect(body.model).toBe('test:model');
    expect(body.messages[0].content).toBe('summarise the diff');
  });
});
