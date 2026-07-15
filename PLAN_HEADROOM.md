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
       ├─► (Jika HEADROOM_URL aktif) ──► POST ${HEADROOM_URL}/v1/compress
       │                                         │
       │  ◄── Kirim balik payload terkompresi ───┘
       │
       ▼ (Kirim payload terkompresi ke Upstream)
Upstream Provider (Copilot/Antigravity/OpenAI)
```

## 2. Checklist Rencana Implementasi

### Phase 1: Konfigurasi & Environment
- [ ] Deteksi environment variable `HEADROOM_URL` (misal: `process.env.HEADROOM_URL`).
- [ ] Tambahkan opsi toggle `headroomEnabled` di skema konfigurasi global Nougate (`config.json` / `config.ts`).

### Phase 2: Middleware / Interceptor
- [ ] Buat file helper `apps/backend/src/core/compressor.ts` atau middleware sejenis.
- [ ] Implementasikan fungsi `compressPayload(body: any): Promise<any>`:
  - Kirim JSON body request (array `messages`, `tools`, dll.) ke `${HEADROOM_URL}/v1/compress`.
  - Jika request ke Headroom sukses, kembalikan body yang sudah terkompresi.
  - Jika request gagal (timeout atau network error), gunakan fallback dengan menggunakan payload asli (tidak memblokir request utama / fail-safe).

### Phase 3: Integrasi dengan Router Core
- [ ] Modifikasi routing handler utama (misalnya di `apps/backend/src/server.ts` atau route executor):
  - Sebelum payload di-dispatch ke provider (`execute` method), panggil helper `compressPayload`.
  - Pastikan kompresi hanya berjalan pada mode chat completions.

### Phase 4: Pengujian & Verifikasi
- [ ] Jalankan service Headroom di docker development environment.
- [ ] Kirim request dengan payload besar (misal membawa `tool_result` atau file diff panjang) dan pastikan token input berkurang secara signifikan di log upstream.
