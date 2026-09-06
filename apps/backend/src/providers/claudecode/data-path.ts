/**
 * Where this provider's state lives, and everywhere it used to.
 *
 * The data directory is named after the provider id, and that id has been renamed twice —
 * `claude-code`, then briefly `cc`, now `claudecode`. Each rename leaves an installation's
 * credentials sitting under a path nothing reads any more, and booting with an empty account list is
 * the worst available answer: a gateway that looks healthy, serves nothing, and gives the operator
 * no reason why.
 *
 * So a read walks the old names newest-first and the next write lands in the current one, which
 * migrates the installation the first time anything changes. Nothing is moved or deleted here: the
 * old copies cost a few kilobytes, and leaving them means rolling back to an earlier build still
 * finds its accounts instead of meeting the same empty list from the other direction.
 */

import { dataPath } from '@/core/paths';

/** The directory this provider writes to, named after its current id. */
export function claudecodeDataPath(file: string): string {
  return dataPath('providers', 'claudecode', file);
}

/**
 * Directory names this provider has answered to before, newest first.
 *
 * Read-only — nothing new is ever written to any of them.
 */
const LEGACY_DIRECTORY_NAMES = ['cc', 'claude-code'];

/**
 * The file to read: the current one, or the newest previous one that still exists.
 *
 * Returns null when none of them do, so the caller states its own default rather than telling
 * "no file" apart from "unreadable file" in two places.
 */
export async function resolveStatePath(file: string): Promise<string | null> {
  const current = claudecodeDataPath(file);
  if (await Bun.file(current).exists()) return current;

  for (const name of LEGACY_DIRECTORY_NAMES) {
    const legacy = dataPath('providers', name, file);
    if (await Bun.file(legacy).exists()) {
      console.log(
        `[claudecode] reading ${file} from the previous "${name}" path; the next write moves it to ${current}`,
      );
      return legacy;
    }
  }

  return null;
}
