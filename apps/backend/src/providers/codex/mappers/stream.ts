/**
 * Re-exports SSE stream helpers for the mappers layer.
 */
export {
  isTerminalEvent,
  buildAbortedTerminalBytes,
  extractSseErrorMessage,
  type PeekResult,
} from '../upstream/stream';
