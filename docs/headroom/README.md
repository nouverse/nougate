# Headroom Integration

This document explains how to use the Headroom compression feature in Nougate.

## What is Headroom?

Headroom is a token compression service that reduces the number of input tokens in your requests by intelligently compressing the payload before sending it to the upstream provider. This can significantly reduce costs and improve performance for requests with large context (e.g., tool results, file diffs, long conversations).

## Configuration

### Docker Deployment (Recommended)

When using docker-compose, Headroom URL is **automatically configured** via environment variable:

```yaml
# docker-compose.yml (already configured)
services:
  nougate:
    environment:
      - HEADROOM_URL=http://headroom:8787
    depends_on:
      - headroom
  
  headroom:
    image: ghcr.io/chopratejas/headroom:latest
    ports:
      - "8787:8787"
```

**To enable:**
1. Deploy with `docker-compose up -d`
2. Navigate to Admin Dashboard → **Config** page
3. Toggle **Enable Compression** in the Headroom section
4. Click **Save Configurations**

That's it! No manual URL configuration needed.

### Manual/Development Setup

For non-docker deployments, set the environment variable manually:

Set the `HEADROOM_URL` environment variable to point to your Headroom service:

```bash
export HEADROOM_URL=http://localhost:8080
```

### Admin Dashboard

You can enable/disable Headroom via the Admin Dashboard:

1. Navigate to **Config** page (`http://localhost:3000/frontend/config`)
2. Scroll to **HEADROOM COMPRESSION (BETA)** section
3. Toggle **Enable Compression**
4. (Optional) Override the Service URL if not using docker-compose
5. (Optional) Adjust the timeout (default: 5000ms)
6. Click **Save Configurations**

**Note:** When using docker-compose, the URL is auto-detected from `HEADROOM_URL` environment variable. You don't need to set it manually.

### Configuration via API

You can also update the configuration programmatically:

```bash
curl -X POST http://localhost:3000/api/config \
  -H "Content-Type: application/json" \
  -d '{
    "headroom": {
      "enabled": true,
      "url": "http://localhost:8080",
      "timeoutMs": 5000
    }
  }'
```

## How It Works

When Headroom is enabled:

1. **Pre-compression**: Before sending a request to the upstream provider, Nougate sends the payload to Headroom's `/v1/compress` endpoint
2. **Compression**: Headroom compresses the payload and returns the compressed version
3. **Upstream**: The compressed payload is sent to the upstream provider (Copilot, Antigravity, OpenAI)

### Fail-Safe Behavior

If Headroom is unreachable or times out:
- Nougate automatically falls back to the **original uncompressed payload**
- The request continues normally without blocking
- A warning is logged to the admin dashboard

This ensures that your gateway remains operational even if the Headroom service is down.

## Supported Protocols

Headroom compression works with:
- ✅ OpenAI protocol (`/openai/v1/chat/completions`)
- ✅ Anthropic protocol (`/anthropic/v1/messages`)

## Configuration Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Master toggle for compression |
| `url` | string | (from `HEADROOM_URL` env) | Service URL override (auto-configured in docker) |
| `timeoutMs` | number | `5000` | Request timeout in milliseconds |

## Runtime Toggle

You can enable/disable Headroom **without restarting** Nougate:
- Changes made via the Admin Dashboard take effect immediately
- No service restart required
- Real-time updates via SSE to the dashboard

## Testing

Run the test suite to verify the integration:

```bash
bun test apps/backend/tests/unit/headroom.test.ts
```

## Example Use Cases

1. **Large tool results**: When your AI uses tools that return large outputs (e.g., file contents, API responses)
2. **Long conversations**: Multi-turn conversations with extensive history
3. **Code diffs**: Requests containing large code diffs or file changes
4. **Cost optimization**: Reduce input token costs on expensive models

## Monitoring

Check the Admin Dashboard logs for Headroom activity:
- `✅ Successfully compressed payload via Headroom` — Compression succeeded
- `⚠️ Headroom request timeout` — Timeout occurred (using original payload)
- `⚠️ Headroom compression failed` — Service error (using original payload)

## Notes

- Headroom only processes requests to `/v1/chat/completions` and `/v1/messages` endpoints
- Model listing and other non-chat endpoints are not compressed
- Compression adds a small latency overhead (typically < 100ms)
- The fail-safe fallback ensures zero downtime if Headroom is unavailable
