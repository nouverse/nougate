import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { compressPayload } from '@/core/compressor';
import { loadProxyConfig, updateProxyConfig, getProxyConfig } from '@/config/manager';

describe('Headroom Compression Integration', () => {
  beforeAll(async () => {
    await loadProxyConfig();
  });

  test('should return original payload when headroom is disabled', async () => {
    // Ensure headroom is disabled
    await updateProxyConfig({
      headroom: {
        enabled: false,
        timeoutMs: 5000,
      }
    });

    const originalPayload = {
      messages: [
        { role: 'user', content: 'Hello, world!' }
      ],
      model: 'test-model'
    };

    const result = await compressPayload(originalPayload);
    expect(result).toEqual(originalPayload);
  });

  test('should return original payload when headroom URL is not configured', async () => {
    // Enable headroom but don't set URL (and assume HEADROOM_URL env is not set)
    await updateProxyConfig({
      headroom: {
        enabled: true,
        url: undefined,
        timeoutMs: 5000,
      }
    });

    // Clear env var if it exists
    const oldEnv = process.env.HEADROOM_URL;
    delete process.env.HEADROOM_URL;

    const originalPayload = {
      messages: [
        { role: 'user', content: 'Test message' }
      ]
    };

    const result = await compressPayload(originalPayload);
    expect(result).toEqual(originalPayload);

    // Restore env
    if (oldEnv) {
      process.env.HEADROOM_URL = oldEnv;
    }
  });

  test('should fallback to original payload when headroom service is unreachable', async () => {
    await updateProxyConfig({
      headroom: {
        enabled: true,
        url: 'http://localhost:9999', // Non-existent service
        timeoutMs: 1000,
      }
    });

    const originalPayload = {
      messages: [
        { role: 'user', content: 'Test message' }
      ]
    };

    const result = await compressPayload(originalPayload);
    expect(result).toEqual(originalPayload); // Should fallback
  }, 5000);

  test('config should contain headroom field with proper defaults', async () => {
    // Reset to default config first
    await updateProxyConfig({
      headroom: {
        enabled: false,
        timeoutMs: 5000,
      }
    });
    
    const config = getProxyConfig();
    expect(config.headroom).toBeDefined();
    expect(config.headroom?.enabled).toBe(false);
    expect(config.headroom?.timeoutMs).toBe(5000);
  });
});
