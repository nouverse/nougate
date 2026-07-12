import { getProxyConfig } from "@/config/manager";
import { eventBus } from "@/providers/antigravity/auth/manager";

const logBuffer: string[] = [];
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};

let consoleCaptureSetup = false;

/**
 * Capture console output for the admin SSE stream.
 */
function captureLog(level: "info" | "warn" | "error", args: unknown[]): void {
  try {
    const message = args
      .map((value) =>
        typeof value === "object" ? JSON.stringify(value, null, 2) : String(value),
      )
      .join(" ");
    const line = `[${new Date().toLocaleTimeString()}] [${level.toUpperCase()}] ${message}`;
    const maxLogs = getProxyConfig().logging.maxBufferSize;

    logBuffer.push(line);
    while (logBuffer.length > maxLogs) {
      logBuffer.shift();
    }

    eventBus.emit("log", line);
  } catch {
  }
}

/**
 * Enable console capture once during server startup.
 */
export function setupLogCapture(): void {
  if (consoleCaptureSetup) {
    return;
  }

  console.log = (...args) => {
    originalConsole.log(...args);
    captureLog("info", args);
  };
  console.warn = (...args) => {
    originalConsole.warn(...args);
    captureLog("warn", args);
  };
  console.error = (...args) => {
    originalConsole.error(...args);
    captureLog("error", args);
  };

  consoleCaptureSetup = true;
}

/**
 * Return a copy of the buffered logs for admin APIs.
 */
export function getCapturedLogs(): string[] {
  return [...logBuffer];
}

/**
 * Normalize duplicate slashes in the request path before routing.
 */
export function normalizePathname(pathname: string): string {
  return pathname.replace(/\/+/g, "/");
}

/**
 * Log the incoming request in a single consistent format.
 */
export function logIncomingRequest(req: Request, cleanPath: string): void {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${cleanPath} - Agent: ${req.headers.get("user-agent")}`,
  );
}

/**
 * Handle CORS preflight requests before they reach the router.
 */
export function handleCorsPreflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") {
    return null;
  }

  return withCorsHeaders(new Response(null, { status: 204 }));
}

/**
 * Add the shared CORS headers to a response.
 */
export function withCorsHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  headers.set("Access-Control-Allow-Headers", "*");
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
