# Rencana Implementasi Provider Baru (GitHub Copilot & Cursor) di Nougate

Rencana ini membagi tugas pembuatan provider baru agar dapat diimplementasikan secara terstruktur.

## Checklist Tugas

### Phase 1: Persiapan & Desain Arsitektur
- [ ] Buat file `PLAN.md` ini di dalam folder `projects/nougate/` untuk tracking progress. (Done)
- [ ] Tentukan skema konfigurasi `config.json` dan struktur penyimpanan token/akun (`accounts.json`) untuk masing-masing provider baru.
- [ ] Buat folder boilerplate di bawah `apps/backend/src/providers/`:
  - [ ] `apps/backend/src/providers/copilot/`
  - [ ] `apps/backend/src/providers/cursor/`

### Phase 2: Implementasi Provider GitHub Copilot
- [ ] Buat `auth/manager.ts` untuk mengelola token Copilot (membaca dari file konfigurasi, rotasi akun, scoring, dan cooldown jika terkena limit).
- [ ] Buat `config/model-specs.ts` untuk memetakan model-model Copilot (misalnya `copilot:gpt-4o`, `copilot:claude-3.5-sonnet`, `copilot:gemini-1.5-pro`).
- [ ] Buat request mapper di folder `mappers/` untuk menerjemahkan format OpenAI/Anthropic yang dikirim OpenClaw ke endpoint Copilot (`api.githubcopilot.com`).
- [ ] Buat handler stream transformer (`mappers/openai-out.ts` & `mappers/anthropic-out.ts`) untuk memformat kembali response stream dari Copilot agar sesuai standar.
- [ ] Buat executor upstream untuk menembak API Copilot secara aman menggunakan token yang aktif.
- [ ] Daftarkan provider Copilot di `apps/backend/src/server.ts`.

### Phase 3: Implementasi Provider Cursor Bypass
- [ ] Buat skema registrasi akun otomatis (atau semi-otomatis) menggunakan email catch-all.
- [ ] Buat `auth/manager.ts` untuk menyimpan cookie/token Cursor yang aktif dan melakukan rotasi akun/cooldown.
- [ ] Buat `config/model-specs.ts` untuk memetakan model Cursor (misalnya `cursor:claude-3.5-sonnet`, `cursor:gpt-4o`).
- [ ] Buat request mapper dan executor untuk menembak endpoint Cursor API dengan menyertakan header otentikasi yang tepat.
- [ ] Daftarkan provider Cursor di `apps/backend/src/server.ts`.

### Phase 4: Pengujian & Refactoring
- [ ] Buat integration test script di `apps/backend/src/scripts/` untuk memverifikasi request ke Copilot.
- [ ] Buat integration test script untuk memverifikasi request ke Cursor.
- [ ] Verifikasi format streaming (SSE) apakah sudah lancar dibaca oleh OpenClaw.
- [ ] Pastikan error handling (seperti rate limit 429) mentrigger cooldown akun dengan benar di Nougate dashboard.
