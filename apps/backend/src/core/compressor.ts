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

  const messageCount = body.messages?.length ?? 0;

  // Skip compression for small payloads — not worth the overhead
  if (messageCount <= 2 && !body.tools) {
    return body;
  }

  // Adaptive timeout: base + extra per message (large payloads need more time)
  const baseTimeoutMs = config.headroom.timeoutMs ?? 5000;
  const timeoutMs = Math.min(baseTimeoutMs + Math.max(0, messageCount - 5) * 500, 15000);
  
  console.log('[Compressor] Sending payload to Headroom:', {
    url: `${headroomUrl}/v1/compress`,
    messageCount: body.messages?.length,
    model: body.model,
    hasTools: !!body.tools,
  });
  
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
    console.log('[Compressor] Original payload keys:', Object.keys(body));
    console.log('[Compressor] Compressed payload keys:', Object.keys(compressed));
    console.log('[Compressor] Compressed payload sample:', JSON.stringify(compressed).slice(0, 200));
    
    // Headroom only returns compressed messages + metadata
    // We need to merge it back with original payload fields (model, stream, tools, etc)
    const mergedPayload = {
      ...body,  // Keep original fields (model, stream, tools, etc)
      messages: compressed.messages || body.messages,  // Use compressed messages
    };
    
    // Log compression stats if available
    if (compressed.tokens_saved) {
      console.log(`[Compressor] Tokens saved: ${compressed.tokens_saved} (${compressed.compression_ratio}x compression)`);
    }
    
    return mergedPayload;
    
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
