#!/usr/bin/env bun
/**
 * Nougate as its own process — bring it up, bind a port, say so.
 *
 * The sequence itself lives in `boot.ts`, which is what a host process imports. Splitting them is
 * what makes hosting possible at all: importing this file starts a server, and that is exactly the
 * behaviour a host cannot have.
 */

import { boot } from "@/boot";
import { NOUGATE_VERSION } from "@/core/version";

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 0,
  fetch: await boot(),
});

console.log(`Nougate v${NOUGATE_VERSION} running on port ${PORT}`);
