import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NOUGATE_VERSION } from '@/core/version';

/**
 * The constant and `package.json` must agree.
 *
 * The version used to be read from `package.json` at runtime, so it could not drift — and it could
 * not be compiled either, since a standalone binary has no `package.json` beside it. Moving it into
 * a constant fixed the second problem and created the first, so this closes it: the release notes,
 * the `/api/status` payload and the startup banner all quote this number, and a stale one sends
 * somebody debugging the wrong build.
 */
describe('the version constant', () => {
  test('matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, '../../package.json'), 'utf8'),
    ) as { version?: string };
    // Asserted before the comparison: a package.json with no version would otherwise make the two
    // sides agree on `undefined` and pass.
    expect(typeof pkg.version).toBe('string');

    const declared = pkg.version as string;
    // Both sides named in the failure, because "expected 0.7.0 to be 0.8.0" does not say which one
    // to change — and the answer is usually both.
    expect({ constant: NOUGATE_VERSION, packageJson: declared }).toEqual({
      constant: declared,
      packageJson: declared,
    });
  });
});
