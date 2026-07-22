/**
 * Parse structured or unstructured error payloads to extract retry/cooldown delays in milliseconds.
 */
export function parseRetryDelay(errorText: string): number {
  try {
    const errorJson = JSON.parse(errorText);
    const details = errorJson.error?.details || [];

    for (const detail of details) {
      // 1. Check detail.metadata fields.
      // These are Go-style duration strings (e.g. "1h58m19.217857537s"),
      // so they must be parsed with parseDurationToMs — NOT parseFloat, which
      // would read only the leading number ("1h..." -> 1 -> 1000ms) and wrongly
      // classify a multi-hour quota reset as a sub-2s transient limit.
      if (detail.metadata) {
        if (detail.metadata.quotaResetDelay) {
          return parseDurationToMs(detail.metadata.quotaResetDelay);
        }
        if (detail.metadata.retryDelay) {
          return parseDurationToMs(detail.metadata.retryDelay);
        }
      }
      
      // 2. Check direct detail retryDelay (Google duration object or string)
      if (detail.retryDelay) {
        if (typeof detail.retryDelay === "object") {
          // Google Duration object, e.g. { seconds: 1, nanos: 500000000 }
          const seconds = parseFloat(detail.retryDelay.seconds || "0");
          const nanos = parseFloat(detail.retryDelay.nanos || "0");
          return (seconds * 1000) + Math.floor(nanos / 1000000);
        }
        if (typeof detail.retryDelay === "string") {
          return parseDurationToMs(detail.retryDelay);
        }
      }
    }

    // 3. Fallback message parsing: e.g. "reset after 1.5s" or "quota will reset in 120s"
    if (errorJson.error?.message) {
      return parseDurationToMs(errorJson.error.message);
    }
  } catch {}

  // 4. Try matching text directly if it is not valid JSON
  return parseDurationToMs(errorText);
}

function parseDurationToMs(val: string): number {
  const regex = /([0-9.]+)\s*(ms|s|m|h)/gi;
  let match;
  let totalMs = 0;
  let hasMatch = false;
  
  while ((match = regex.exec(val)) !== null) {
    hasMatch = true;
    totalMs += convertToMs(parseFloat(match[1]), match[2].toLowerCase());
  }
  
  if (!hasMatch) {
    const parsed = parseFloat(val.trim());
    return isNaN(parsed) ? 0 : parsed * 1000;
  }
  
  return totalMs;
}

function convertToMs(amount: number, unit: string): number {
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60000,
    h: 3600000,
  };
  return amount * (multipliers[unit] ?? 1000);
}
