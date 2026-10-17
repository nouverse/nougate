/**
 * Inside a host, the process and its signals are the host's.
 *
 * The gateway used to install a SIGINT/SIGTERM handler that called `process.exit` as soon as it loaded — before
 * Nouride's own, since Nouride loads it during boot — so a router edition's daemon exited at once on SIGTERM and its
 * shutdown never ran: no turn stopped and saved, no clean stop recorded. A gateway on its own answers the signals in
 * `standalone.ts`; a host calls `shutdown()` from `boot.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe("the host's signals", () => {
  test("loading the gateway installs no handler of its own: the host's runs", () => {
    const home = mkdtempSync(join(tmpdir(), 'nougate-signals-'));
    try {
      const script = [
        `await import(${JSON.stringify(join(import.meta.dir, '../../src/boot.ts'))});`,
        `process.on("SIGTERM", () => process.exit(7));`,
        `process.kill(process.pid, "SIGTERM");`,
        `await new Promise((resolve) => setTimeout(resolve, 2000));`,
      ].join('\n');
      const run = spawnSync(process.execPath, ['-e', script], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...process.env, NOUGATE_HOME: home, NOUGATE_DB_PATH: join(home, 'n.db') },
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(run.status).toBe(7);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
