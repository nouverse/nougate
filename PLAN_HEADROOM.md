# Rencana Implementasi Integrasi Headroom di Nougate

Dokumen ini menjelaskan rencana untuk mengintegrasikan **Headroom** sebagai middleware kompresi token (input/prompt compression) di Nougate.

---

## 1. Alur Kerja Integrasi
```
Client (Cursor/Cline/OpenClaw) 
       │
       ▼ (POST /v1/chat/completions)
   Nougate Backend
       │
       ├─► (Jika headroom.enabled == true) ──► POST ${headroomUrl}/v1/compress
       │                                               │
       │  ◄── Kirim balik payload terkompresi ─────────┘
       │
       ▼ (Kirim payload terkompresi ke Upstream)
Upstream Provider (Copilot/Antigravity/OpenAI)
```

## 2. Checklist Rencana Implementasi

### Phase 1: Konfigurasi & Environment
- [x] Deteksi environment variable `HEADROOM_URL` (misal: `process.env.HEADROOM_URL`) sebagai base URL default service Headroom.
- [x] Tambahkan field `headroom` di `ProxyConfig` (`apps/backend/src/config/types.ts`):
  ```ts
  headroom?: {
    enabled: boolean;   // toggle utama dari admin, default false
    url?: string;       // override URL (fallback ke env HEADROOM_URL)
    timeoutMs?: number; // timeout request ke Headroom, default 5000
  };
  ```
- [x] Admin bisa toggle `headroom.enabled` via endpoint `PATCH /admin/config` (sudah ada pattern di `updateProxyConfig`).
- [x] Dashboard admin menampilkan toggle switch untuk enable/disable Headroom secara **runtime** (tanpa restart).

### Phase 2: Middleware / Interceptor
- [x] Buat file helper `apps/backend/src/core/compressor.ts`.
- [x] Implementasikan fungsi `compressPayload(body: any): Promise<any>`:
  - Cek `getProxyConfig().headroom?.enabled` — jika `false` atau undefined, langsung return body asli (no-op).
  - Resolve URL dari `config.headroom.url ?? process.env.HEADROOM_URL`.
  - Kirim JSON body request (array `messages`, `tools`, dll.) ke `${resolvedUrl}/v1/compress`.
  - Jika request ke Headroom sukses, kembalikan body yang sudah terkompresi.
  - Jika request gagal (timeout atau network error), gunakan fallback dengan menggunakan payload asli (fail-safe, tidak memblokir request utama).
  - Log warning ke `adminEventBus` jika terjadi fallback.

### Phase 3: Integrasi dengan Router Core
- [x] Modifikasi routing handler utama (misalnya di `apps/backend/src/server.ts` atau route executor):
  - Sebelum payload di-dispatch ke provider (`execute` method), panggil helper `compressPayload`.
  - Pastikan kompresi hanya berjalan pada mode chat completions.
- [x] Tambahkan endpoint admin (atau reuse `PATCH /admin/config`) untuk toggle `headroom.enabled` secara runtime.
- [x] Emit event via `adminEventBus` saat status headroom berubah agar dashboard bisa reflect real-time.

### Phase 4: Pengujian & Verifikasi
- [x] Jalankan service Headroom di docker development environment.
- [x] Test toggle: pastikan saat `headroom.enabled = false`, request TIDAK dikirim ke Headroom sama sekali.
- [x] Test toggle: pastikan saat `headroom.enabled = true`, payload dikompresi sebelum dikirim ke upstream.
- [x] Kirim request dengan payload besar (misal membawa `tool_result` atau file diff panjang) dan pastikan token input berkurang secara signifikan di log upstream.
- [x] Test fail-safe: matikan service Headroom, pastikan request tetap jalan normal dengan payload asli.

---

## Status Implementasi

✅ **SELESAI** - Semua fase telah diimplementasikan dengan **Docker-First Approach**:

1. **Config & Types** — Added `HeadroomConfig` to `ProxyConfig` with admin toggle support
2. **Compressor Middleware** — Created `compressor.ts` with fail-safe fallback
3. **Protocol Integration** — Integrated compression into OpenAI and Anthropic handlers
4. **Admin Dashboard** — Added UI controls for runtime configuration
5. **Testing** — Full unit test coverage with 4 passing tests
6. **Documentation** — Created comprehensive guide at `docs/headroom/`
7. **Docker-First Config** ✨ — URL auto-detected from `HEADROOM_URL` env (zero manual config)

### 🐳 Docker-First Deployment

**Zero Configuration Required:**
```bash
# 1. Deploy (URL sudah configured di docker-compose.yml)
docker-compose up -d

# 2. Enable via dashboard
# Admin Dashboard → Config → Headroom → Toggle ON → Save

# Done! No manual URL setup needed.
```

**What's Auto-Configured:**
- ✅ `HEADROOM_URL=http://headroom:8787` (in docker-compose.yml)
- ✅ Service dependency (`depends_on: headroom`)
- ✅ Runtime config auto-loads URL from env
- ✅ Admin UI shows docker-aware hints

**Manual Deployment (if not using docker):**
- Set `export HEADROOM_URL=http://localhost:8787`
- Then enable via dashboard
