/**
 * Where this provider's state lives, and where it used to.
 *
 * The provider's id changed from `claude-code` to `cc`, and the data directory is named after the
 * id — so an installation that predates the rename has its credentials sitting under a path nothing
 * reads any more. Booting with an empty account list would be the worst available answer: a gateway
 * that looks healthy, serves nothing, and gives the operator no reason why.
 *
 * So a read falls back to the pre-rename location and the next write lands in the current one, which
 * migrates the installation the first time anything changes. Nothing is moved or deleted here: the
 * old copy costs a few kilobytes, and leaving it means rolling back to the previous build still
 * finds its accounts instead of meeting the same empty list from the other direction.
 */

import { dataPath } from '@/core/paths';

/** The directory this provider writes to, named after its current id. */
export function ccDataPath(file: string): string {
  return dataPath('providers', 'cc', file);
}

/** The directory it wrote to before the rename. Read-only — nothing new is ever put here. */
export function legacyCcDataPath(file: string): string {
  return dataPath('providers', 'claude-code', file);
}

/**
 * The file to read: the current one, or the pre-rename one when the current one is not there yet.
 *
 * Returns null when neither exists, so the caller states its own default rather than distinguishing
 * "no file" from "unreadable file" twice.
 */
export async function resolveStatePath(file: string): Promise<string | null> {
  const current = ccDataPath(file);
  if (await Bun.file(current).exists()) return current;

  const legacy = legacyCcDataPath(file);
  if (await Bun.file(legacy).exists()) {
    console.log(`[cc] reading ${file} from the pre-rename path; the next write moves it to ${current}`);
    return legacy;
  }

  return null;
}
