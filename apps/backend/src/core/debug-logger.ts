import { getProxyConfig } from '@/config/manager';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

/**
 * Debug Payload Logger
 * Dumps request/response JSON payloads to disk when enabled.
 * Fail-safe: errors are swallowed to never affect request flow.
 */

let outputDir: string | null = null;

function ensureDir(): string | null {
  const config = getProxyConfig();
  if (!config.debugLogger?.enabled) return null;

  if (!outputDir) {
    outputDir = config.debugLogger.outputDir || './tmp/debug-payloads';
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }
  }
  return outputDir;
}

function matchesFilter(model: string): boolean {
  const config = getProxyConfig();
  const filters = config.debugLogger?.modelFilter;
  if (!filters || filters.length === 0) return true;
  return filters.some(f => {
    if (f.includes('*')) {
      const regex = new RegExp('^' + f.replace(/\*/g, '.*') + '$');
      return regex.test(model);
    }
    return model === f;
  });
}

export async function logRequestPayload(requestId: string, model: string, body: any): Promise<void> {
  try {
    const dir = ensureDir();
    if (!dir || !matchesFilter(model)) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${timestamp}_${requestId}_req.json`;
    await Bun.write(join(dir, filename), JSON.stringify({ model, body }, null, 2));
  } catch {
    // fail-safe: never throw
  }
}

export async function logResponsePayload(requestId: string, model: string, status: number, headers?: Record<string, string>, bodyPreview?: string): Promise<void> {
  try {
    const dir = ensureDir();
    if (!dir || !matchesFilter(model)) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${timestamp}_${requestId}_res.json`;
    await Bun.write(join(dir, filename), JSON.stringify({ model, status, headers, bodyPreview }, null, 2));
  } catch {
    // fail-safe: never throw
  }
}
