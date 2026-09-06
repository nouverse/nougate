import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { NOUGATE_VERSION } from '@/core/version';
import { projectPath } from '@/core/paths';

/**
 * The constant and every `package.json` that names this product must agree.
 *
 * The version used to be read from `package.json` at runtime, so it could not drift — and it could
 * not be compiled either, since a standalone binary has no `package.json` beside it. Moving it into
 * a constant fixed the second problem and created the first, so this closes it: the release notes,
 * the `/api/status` payload, the `/api/version` the dashboard footer reads, and the startup banner
 * all quote this number, and a stale one sends somebody debugging the wrong build.
 *
 * All three manifests, not just the backend's. The dashboard shipped `v0.7.0` hardcoded in its
 * sidebar while its own manifest said `0.1.0` and the gateway said `0.7.0` — three numbers for one
 * product, none of them checked against the others.
 */
// Resolved through `projectPath` rather than by counting `../` out of this file: the walk-up it does
// is the same one the running gateway uses to find its own root, so these cannot point somewhere the
// application would not.
const MANIFESTS = {
  root: 'package.json',
  backend: 'apps/backend/package.json',
  frontend: 'apps/frontend/package.json',
} as const;

describe('the version constant', () => {
  for (const [name, relative] of Object.entries(MANIFESTS)) {
    test(`matches the ${name} package.json`, () => {
      const pkg = JSON.parse(readFileSync(projectPath(relative), 'utf8')) as {
        version?: string;
      };
      // Asserted before the comparison: a package.json with no version would otherwise make the two
      // sides agree on `undefined` and pass.
      expect(typeof pkg.version).toBe('string');

      const declared = pkg.version as string;
      // Both sides named in the failure, because "expected 0.7.0 to be 1.0.0" does not say which one
      // to change — and the answer is usually both.
      expect({ constant: NOUGATE_VERSION, [name]: declared }).toEqual({
        constant: declared,
        [name]: declared,
      });
    });
  }
});
