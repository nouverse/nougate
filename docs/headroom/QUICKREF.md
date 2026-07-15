# Headroom Quick Reference

## ⚡ Quick Commands

### Enable Headroom via API
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

### Disable Headroom via API
```bash
curl -X POST http://localhost:3000/api/config \
  -H "Content-Type: application/json" \
  -d '{
    "headroom": {
      "enabled": false
    }
  }'
```

### Check Current Config
```bash
curl http://localhost:3000/api/config | jq '.headroom'
```

## 🔧 Environment Variables

**Docker Deployment (Auto-configured):**
```yaml
# docker-compose.yml (already set)
services:
  nougate:
    environment:
      - HEADROOM_URL=http://headroom:8787
```

**Manual/Development:**
```bash
# Set manually if not using docker-compose
export HEADROOM_URL=http://localhost:8787

# Optional: Custom config file path
export CONFIG_FILE=/path/to/config.json
```

## 📊 Log Messages Reference

| Log Message | Meaning | Action Needed |
|------------|---------|---------------|
| `[Compressor] Successfully compressed payload via Headroom` | ✅ Compression working | None |
| `[Compressor] Headroom enabled but no URL configured` | ⚠️ Missing URL | Set `HEADROOM_URL` or config URL |
| `[Compressor] Headroom request timeout after Xms` | ⚠️ Service slow/down | Check Headroom service health |
| `[Compressor] Headroom compression failed: ...` | ⚠️ Service error | Check Headroom logs |

## 🎛️ Config Schema

```typescript
interface HeadroomConfig {
  enabled: boolean;      // Master toggle (default: false)
  url?: string;          // Service URL (fallback: HEADROOM_URL env)
  timeoutMs?: number;    // Request timeout (default: 5000)
}
```

## 📏 Admin Dashboard

**Docker Deployment (Recommended):**
1. Navigate to: `http://localhost:3000/frontend/config`
2. Scroll to: **HEADROOM COMPRESSION**
3. Toggle: **Enable Compression** ✅
4. Click: **Save Configurations**
5. Done! URL is auto-detected from docker-compose

**Manual Override (if needed):**
- Set custom URL in the "Service URL" field
- Adjust timeout if needed

## 🧪 Test Scenarios

### Test 1: Disabled State
```bash
# Should use original payload
curl -X POST http://localhost:3000/openai/v1/chat/completions \
  -H "Authorization: Bearer sk-test" \
  -d '{
    "model": "copilot:gpt-4o",
    "messages": [{"role": "user", "content": "Test"}]
  }'
```

### Test 2: Enabled with Mock Service
```bash
# Start mock Headroom (returns same payload)
docker run -p 8080:8080 mock-headroom

# Enable in Nougate
curl -X POST http://localhost:3000/api/config \
  -d '{"headroom": {"enabled": true, "url": "http://localhost:8080"}}'

# Send test request
curl -X POST http://localhost:3000/openai/v1/chat/completions \
  -H "Authorization: Bearer sk-test" \
  -d '{
    "model": "copilot:gpt-4o",
    "messages": [{"role": "user", "content": "Large payload test..."}]
  }'
```

### Test 3: Fail-Safe (Service Down)
```bash
# Stop Headroom service
docker stop mock-headroom

# Request should still work (fallback)
curl -X POST http://localhost:3000/openai/v1/chat/completions \
  -H "Authorization: Bearer sk-test" \
  -d '{
    "model": "copilot:gpt-4o",
    "messages": [{"role": "user", "content": "Test"}]
  }'
```

## 🚨 Troubleshooting

| Problem | Solution |
|---------|----------|
| Compression not working | Check `enabled: true` and URL is set |
| All requests timing out | Increase `timeoutMs` or check Headroom health |
| Requests bypass Headroom | Verify protocol endpoint (`/v1/chat/completions` or `/v1/messages`) |
| Config not persisting | Check `CONFIG_FILE` path and write permissions |

## 📈 Performance Metrics

Monitor these metrics:
- Compression success rate
- Average compression latency
- Token reduction percentage
- Fallback rate

## 🔐 Security Notes

- Headroom service should be in trusted network
- Use HTTPS for production deployments
- Consider API authentication for Headroom endpoint
- Monitor for payload tampering

## 📞 Support

- **Issues**: Check [IMPLEMENTATION.md](./IMPLEMENTATION.md)
- **Architecture**: See [FLOW.md](./FLOW.md)
- **Full Guide**: Read [README.md](./README.md)
