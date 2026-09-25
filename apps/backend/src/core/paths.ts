import { cpSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Where runtime state lives.
 *
 * These must never be derived from `process.cwd()`: the backend is started
 * from the repo root by Docker (`bun run apps/backend/src/server.ts`) but from
 * `apps/backend` by the workspace script (`bun run --filter ... dev`). Anchoring
 * to the current directory silently produces a *second* set of state files, so
 * anything saved under one launch method is invisible under the other.
 *
 * Everything here is resolved from this module's own location instead.
 *
 * ## And that stopped being enough once this had to compile
 *
 * `bun build --compile` puts the source in a virtual filesystem, so `import.meta.dir` becomes a path
 * under `/$bunfs/` that exists only to Bun's own resolver. The walk-up below then finds nothing real
 * — and worse, it cannot *tell* that it found nothing, because `existsSync()` answers true for paths
 * inside that virtual filesystem. It would either fall through to `process.cwd()`, scattering state
 * wherever the binary happened to be started from, or match a `package.json` that is not on disk.
 *
 * So there are now three answers, most explicit first: an operator's `NOUGATE_HOME`, the directory
 * the executable sits in when this is a compiled binary, and the walk-up for a checkout. The middle
 * one is the layout `nouride` uses for the same problem — state and assets as siblings of the
 * binary — so an install of either looks the same on disk.
 */

const MAX_WALK_UP = 10;

/**
 * Bun's virtual filesystem root inside a `--compile` binary.
 *
 * Detected by prefix rather than by asking whether the path exists, because it *does*: `existsSync()`
 * cannot distinguish a bundled file from one on disk, so an existence check sees no difference
 * between a compiled binary and a checkout.
 */
const BUNFS_PREFIX = '/$bunfs/';

/** True when running from a `bun build --compile` executable rather than from source. */
export function isCompiledBinary(): boolean {
  return import.meta.dir.startsWith(BUNFS_PREFIX);
}

let cachedRoot: string | null = null;

/**
 * True when a package.json declares workspaces, i.e. it is the monorepo root
 * rather than the backend package.
 */
function declaresWorkspaces(packageJsonPath: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    return Array.isArray(parsed?.workspaces) || typeof parsed?.workspaces === 'object';
  } catch {
    return false;
  }
}

/**
 * Resolve the project root by walking up from this file.
 *
 * Prefers the monorepo root (the package.json that declares workspaces) and
 * falls back to the nearest package.json — which is what the production Docker
 * image has, since it ships only the backend package at /app.
 */
export function getProjectRoot(): string {
  if (cachedRoot) {
    return cachedRoot;
  }

  /**
   * An operator saying where the install lives, which beats every guess below.
   *
   * The escape hatch for anything the two rules after it get wrong: a binary on a read-only path, a
   * container that mounts state elsewhere, two installs on one host.
   */
  const home = process.env.NOUGATE_HOME?.trim();
  if (home) {
    cachedRoot = home;
    return cachedRoot;
  }

  /**
   * A compiled binary has no repository to walk up through, so its own directory is the root.
   *
   * `process.execPath` is the real file on disk even when `import.meta.dir` is virtual, which is
   * what makes this the one reliable anchor inside a standalone build.
   */
  if (isCompiledBinary()) {
    cachedRoot = dirname(process.execPath);
    return cachedRoot;
  }

  let current = import.meta.dir;
  let nearestPackageDir: string | null = null;

  for (let depth = 0; depth < MAX_WALK_UP; depth += 1) {
    const packageJsonPath = join(current, 'package.json');

    if (existsSync(packageJsonPath)) {
      if (declaresWorkspaces(packageJsonPath)) {
        cachedRoot = current;
        return cachedRoot;
      }
      nearestPackageDir ??= current;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  cachedRoot = nearestPackageDir ?? process.cwd();
  return cachedRoot;
}

/**
 * Directory holding persistent state: the SQLite database, provider account
 * files, and config.
 *
 * In Docker this is the mounted volume at /app/data; locally it is `data/` at
 * the project root.
 *
 * **`NOUGATE_HOME` first, and read on every call.** A host that runs nougate in
 * its own process (Nouride) sets it so the database lands in the host's volume.
 * `/app/data` used to be checked first — this image's own layout — and the
 * Nouride image had that directory too, so in a Nouride container every account
 * and provider went to a path no volume covered and a recreate wiped them.
 */
export function getDataDir(): string {
  const home = process.env.NOUGATE_HOME?.trim();
  if (home) return join(home, 'data');
  return existsSync('/app/data') ? '/app/data' : join(getProjectRoot(), 'data');
}

/**
 * Resolve a path inside the data directory.
 */
export function dataPath(...segments: string[]): string {
  return join(getDataDir(), ...segments);
}

/**
 * Resolve a path relative to the project root (source and repo-tracked files,
 * not runtime state).
 */
export function projectPath(...segments: string[]): string {
  return join(getProjectRoot(), ...segments);
}

/**
 * Every name this gateway keeps in its data directory: what the `dataPath()` callers write, and the
 * SQLite files beside the database.
 */
const STATE_FILES = [
  'nougate.db',
  'nougate.db-wal',
  'nougate.db-shm',
  'config.json',
  'calibration.json',
  '.session-secret',
  'providers',
] as const;

/**
 * Bring this gateway's state into `getDataDir()` from where a host kept it before, once.
 *
 * For a host that moved where it points `NOUGATE_HOME` (Nouride did, to give the gateway a folder of
 * its own). Only when the data directory has no database yet, and only from the first source that has
 * one — so it runs on the first start after the move and never again, and never replaces a database
 * in use. Call it **before** `boot()`: nothing is open, so the database and its WAL are copied as one
 * consistent set.
 *
 * **Copied, never moved.** The host's previous build may come back — an update that does not start
 * is rolled back — and it looks where it always did. Moved, it would find the gateway empty.
 *
 * Copied by name, never as a directory, because a source may be the host's own data directory, full
 * of files that are not this gateway's. Returns the source used, or null.
 */
export function adoptStateFrom(sources: readonly string[]): string | null {
  const target = getDataDir();
  if (existsSync(join(target, 'nougate.db'))) return null;
  const source = sources.find((dir) => existsSync(join(dir, 'nougate.db')));
  if (!source) return null;

  mkdirSync(target, { recursive: true });
  for (const name of STATE_FILES) {
    const from = join(source, name);
    if (existsSync(from)) cpSync(from, join(target, name), { recursive: true, force: false, errorOnExist: false });
  }
  return source;
}
