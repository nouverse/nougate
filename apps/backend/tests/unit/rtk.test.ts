import { describe, expect, test } from 'bun:test';

import { compressText } from '@/core/rtk';

/**
 * RTK rewrites tool results before the model sees them, so the case that matters most is the one where
 * it must do nothing: a file an agent reads. Both regressions here were found on a live deployment —
 * an agent reading a skill got 30 of its 121 lines, and a source file came back unindented.
 */

const SKILL = [
  '---',
  'name: coding-agents',
  'description: Hand coding work to a coding agent CLI and drive it from the shell.',
  '---',
  '',
  '# Driving a coding agent',
  '',
  'A coding agent CLI is a worker you run with exec. You give it one task; it edits files and runs',
  'commands in a repository until it is done; you read what it did.',
  '',
  '## 1. Pick one',
  '',
  '1. The one the person named.',
  '2. Otherwise one already here.',
  '',
  'Then read its page in the references folder beside this file.',
  '',
  '## 3. Sign it in',
  '',
  '- Check that it is set. Never print it, not even part of it.',
  '- Point the config at the variable, never at its value. Write it with a quoted heredoc.',
  '- Keep the config in your home. One inside the repository gets committed.',
  '',
  '## 7. Check, then report',
  '',
  'Run the tests yourself, and check no key landed in a file before you report.',
].join('\n');

const PYTHON = [
  'def count(text):',
  '    if not text:',
  '        return 0',
  '    return len(text.split())',
  '',
  '',
  'def top(text, n):',
  '    if not text:',
  '        return []',
  '    return sorted(text.split())[:n]',
  '',
  '',
  'def main():',
  '    if not text:',
  '        return 0',
  '    return 1',
  '',
  '',
  'def other():',
  '    if not text:',
  '        return []',
  '    return None',
].join('\n');

describe('a file an agent reads reaches the model as it is', () => {
  test('front matter is not a diff: a skill keeps every line', () => {
    expect(SKILL.length).toBeGreaterThan(500);
    expect(compressText(SKILL)).toBe(SKILL);
  });

  test('code that repeats lines is not a log: indentation, blank lines and order survive', () => {
    expect(compressText(PYTHON)).toBe(PYTHON);
  });
});

describe('what RTK is for still compresses', () => {
  test('a git diff loses its surplus context lines', () => {
    const diff = [
      'diff --git a/wordcount.py b/wordcount.py',
      '--- a/wordcount.py',
      '+++ b/wordcount.py',
      '@@ -1,9 +1,10 @@',
      ' import sys',
      ' ',
      ' def count(text):',
      ' context four',
      ' context five',
      '-    return 0',
      '+    return 1',
    ].join('\n');
    const compressed = compressText(diff);
    expect(compressed).not.toContain('context four');
    expect(compressed).toContain('+    return 1');
  });

  test('a log stuck on one line collapses to that line and a count, in place', () => {
    const log = ['start', ...Array.from({ length: 12 }, () => '  retrying connection'), 'done'].join('\n');
    expect(compressText(log)).toBe('start\n  retrying connection  (×12)\ndone');
  });
});
