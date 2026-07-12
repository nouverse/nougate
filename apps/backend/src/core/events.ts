import { EventEmitter } from "node:events";

/**
 * Global event bus for real-time dashboard events (logs, updates, cooldowns, status flashes).
 */
export const adminEventBus = new EventEmitter();
