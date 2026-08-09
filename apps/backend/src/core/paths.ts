import { existsSync, readFileSync } from 'fs';
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
 */

const MAX_WALK_UP = 10;

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
 */
export function getDataDir(): string {
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
