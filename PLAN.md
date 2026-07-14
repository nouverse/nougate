# Rencana Implementasi Provider GitHub Copilot di Nougate

Rencana ini difokuskan khusus untuk pembuatan provider GitHub Copilot sebagai LLM upstream di Nougate.

## Checklist Tugas (GitHub Copilot Only)

### Phase 1: Persiapan & Desain Arsitektur
- [x] Buat file `PLAN.md` ini di dalam folder `projects/nougate/` untuk tracking progress.
- [ ] Tentukan skema konfigurasi `config.json` dan struktur penyimpanan token/akun (`accounts.json`) khusus untuk Copilot.
- [ ] Buat folder boilerplate di `apps/backend/src/providers/copilot/`.

### Phase 2: Implementasi Provider GitHub Copilot
- [ ] Buat `auth/manager.ts` untuk mengelola token Copilot (membaca dari file konfigurasi, rotasi akun, scoring, dan cooldown jika terkena limit).
- [ ] Buat `config/model-specs.ts` untuk memetakan model-model Copilot (misalnya `copilot:gpt-4o`, `copilot:claude-3.5-sonnet`, `copilot:gemini-1.5-pro`).
- [ ] Buat request mapper di folder `mappers/` untuk menerjemahkan format OpenAI/Anthropic yang dikirim OpenClaw ke endpoint Copilot (`api.githubcopilot.com`).
- [ ] Buat handler stream transformer (`mappers/openai-out.ts` & `mappers/anthropic-out.ts`) untuk memformat kembali response stream dari Copilot agar sesuai standar.
- [ ] Buat executor upstream untuk menembak API Copilot secara aman menggunakan token yang aktif.
- [ ] Daftarkan provider Copilot di `apps/backend/src/server.ts`.

### Phase 3: Pengujian & Refactoring
- [ ] Buat integration test script di `apps/backend/src/scripts/test-copilot.ts` untuk memverifikasi request ke Copilot.
- [ ] Verifikasi format streaming (SSE) apakah sudah lancar dibaca oleh OpenClaw.
- [ ] Pastikan error handling (seperti rate limit 429) mentrigger cooldown akun dengan benar di Nougate dashboard.
