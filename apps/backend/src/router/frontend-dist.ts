import { dirname, join } from "path";
import { existsSync, readFileSync } from "fs";
import { projectPath } from "@/core/paths";
import { isEmbeddable } from "@/router/entry-document";

/**
 * Where the built dashboard is, checked in order and remembered by nobody — this runs per request,
 * and `existsSync` on four paths is cheaper than the file read that follows it.
 *
 * The last entry is the compiled-binary layout: `bun build --compile` leaves `import.meta.dir`
 * pointing into a virtual filesystem, so the first three resolve to paths that are not on disk.
 * A release stages the dashboard as a sibling of the executable, the same way `nouride` does.
 *
 * ## The candidate is the entry document, not the directory
 *
 * It used to be `existsSync(dir)`, and an **empty** `dist` satisfies that. Vite builds with
 * `emptyOutDir: true`, so it clears the directory before it writes — a build that fails partway
 * leaves the directory in place with nothing in it. The check passed, the read did not, and the
 * dashboard answered `ENOENT: … /dist/index.html` with a 500.
 *
 * Testing for `index.html` makes an empty directory fall through to the next candidate, which in
 * a container is often a perfectly good copy at another path.
 */
export function frontendDistCandidates(): string[] {
  return [
    join(import.meta.dir, "../../../frontend/dist"),
    projectPath("apps/frontend/dist"),
    projectPath("frontend/dist"),
    join(dirname(process.execPath), "frontend"),
  ];
}

export function findFrontendDist(): string | undefined {
  return frontendDistCandidates().find((dir) => existsSync(join(dir, "index.html")));
}

/**
 * Whether the dashboard on disk can be shown inside a host (`entry-document.ts`, `isEmbeddable`).
 *
 * Asked by a host before it offers the page. The bundle sits beside the executable and is updated
 * separately from it, so a gateway new enough to be hosted can find itself beside a bundle that is
 * not — and that bundle, framed, would call the host's API instead of this one.
 */
export function dashboardEmbeddable(): boolean {
  const dist = findFrontendDist();
  if (!dist) return false;
  try {
    return isEmbeddable(readFileSync(join(dist, "index.html"), "utf8"));
  } catch {
    return false;
  }
}
