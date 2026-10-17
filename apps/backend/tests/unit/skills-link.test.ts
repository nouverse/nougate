import { describe, expect, test } from 'bun:test';
import { lstatSync, readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The contributing skill lives once, in `.agents/skills`, and `.claude/skills` is a link to it.
 *
 * They were two real directories, and they drifted: the `.claude` copy of `adding-a-provider.md`
 * gained `getJitterConfig()` — required of every provider — and the `.agents` copy never did, so an
 * agent reading that one was taught a provider contract the code no longer has. A link cannot drift.
 */

const ROOT = join(import.meta.dir, '../../../..');

describe('the contributing skill', () => {
  test('.claude/skills is a link to .agents/skills, not a copy', () => {
    const link = join(ROOT, '.claude/skills');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe('../.agents/skills');
  });

  test('and the directory it points at is there', () => {
    expect(statSync(join(ROOT, '.agents/skills/nougate-contributing/SKILL.md')).isFile()).toBe(true);
  });
});
