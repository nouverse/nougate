import { getProxyConfig } from '@/config/manager';
import { adminEventBus } from '@/core/events';

/**
 * Compress the request payload using Headroom service if enabled.
 * Falls back to original payload on failure (fail-safe).
 */
export async function compressPayload(body: any): Promise<any> {
  const config = getProxyConfig();
  
  // Early return if headroom is disabled
  if (!config.headroom?.enabled) {
    return body;
  }

  // Resolve URL from config or env
  const headroomUrl = config.headroom.url ?? process.env.HEADROOM_URL;
  
  if (!headroomUrl) {
    console.warn('[Compressor] Headroom enabled but no URL configured (config.headroom.url or HEADROOM_URL env)');
    return body;
  }

  const timeoutMs = config.headroom.timeoutMs ?? 5000;
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${headroomUrl}/v1/compress`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Headroom returned ${response.status}: ${response.statusText}`);
    }

    const compressed = await response.json();
    
    console.log('[Compressor] Successfully compressed payload via Headroom');
    return compressed;
    
  } catch (error: any) {
    const errorMsg = error.name === 'AbortError' 
      ? `Headroom request timeout after ${timeoutMs}ms`
      : `Headroom compression failed: ${error.message}`;
    
    console.warn(`[Compressor] ${errorMsg}, using original payload (fail-safe)`);
    
    // Emit warning event to admin dashboard
    adminEventBus.emit('log', `⚠️ ${errorMsg}`);
    
    return body;
  }
}
