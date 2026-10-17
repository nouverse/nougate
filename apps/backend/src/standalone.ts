/**
 * What a gateway that is its own process does, and a hosted one must not: answer SIGINT and SIGTERM.
 *
 * The process is the gateway's, so on either signal what the heartbeat and the state files hold is written and the
 * database closed (`shutdown()` in `boot.ts`), then it exits. Inside a host the signals are the host's, and the host
 * calls `shutdown()` from its own shutdown: a handler installed by the gateway there ran before the host's and ended
 * the process under it.
 */

import { shutdown } from "@/boot";

export function shutDownOnSignals(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown()
        .catch((error) => console.error("[Shutdown] Could not write what was held:", error))
        .finally(() => process.exit(0));
    });
  }
}
