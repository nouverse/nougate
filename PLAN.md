# Rencana Implementasi Provider GitHub Copilot di Nougate

Dokumen ini menjelaskan rencana implementasi untuk mengintegrasikan **GitHub Copilot** sebagai upstream provider di Nougate, berdampingan dengan Antigravity.

> **Referensi arsitektur**: [ARCHITECTURE.md](./ARCHITECTURE.md) — semua provider mengimplementasi `IProvider` interface dan didaftarkan ke Provider Registry.

---

## 0. Context & Analisis

### Perbedaan dengan Antigravity
| Aspek | Antigravity | Copilot |
|---|---|---|
| Auth | Google OAuth (browser redirect) | GitHub OAuth **Device Flow** (code-based, no redirect) |
| Token chain | Google refresh token → access token | GitHub OAuth → `ghu_*` personal token → session token (25-30 min) |
| Upstream API | Google Vertex/AI (custom format) | `api.githubcopilot.com` (OpenAI-compatible) |
| Request mapper | Complex (OpenAI/Anthropic → Google format) | Minimal (passthrough, already OpenAI format) |
| Response mapper | Complex (Google SSE → OpenAI/Anthropic SSE) | Minimal (already OpenAI SSE, hanya perlu reformat untuk Anthropic) |

### Alur Auth GitHub Copilot (3 Layer)
```
┌──────────────────────────────────────────────────────────────────────────┐
│ Layer 1: GitHub OAuth Device Flow                                        │
│   POST https://github.com/login/device/code                              │
│   → user_code (ditampilkan ke admin) + device_code                       │
│   → Admin buka https://github.com/login/device & masukkan user_code      │
│   → Poll POST https://github.com/login/oauth/access_token sampai granted │
│   → Dapat access_token (GitHub OAuth token)                              │
├──────────────────────────────────────────────────────────────────────────┤
│ Layer 2: Copilot Personal Token                                          │
│   Dari GitHub OAuth access_token, kita bisa langsung pakai sebagai       │
│   personal token untuk exchange session token.                           │
│   ATAU admin bisa langsung paste token dari                              │
│   ~/.config/github-copilot/hosts.json (format ghu_xxx / gho_xxx)        │
├──────────────────────────────────────────────────────────────────────────┤
│ Layer 3: Session Token Exchange (per-request)                            │
│   GET https://api.github.com/copilot_internal/v2/token                   │
│   Authorization: Bearer <personal_token>                                 │
│   → session token (berlaku ~25-30 menit)                                 │
│   → Cache & auto-refresh sebelum expired                                 │
└──────────────────────────────────────────────────────────────────────────┘
```

### Mengapa Perlu "Sign Up with GitHub"?
- Token `ghu_*` / `gho_*` dari `hosts.json` bisa langsung dipaste manual, **tapi**:
  - Tidak semua admin punya akses ke file system server (terutama di Docker).
  - Kita ingin flow yang smooth dari dashboard — klik "Add Account" → login GitHub → done.
- **GitHub OAuth Device Flow** adalah cara paling clean:
  - Tidak butuh redirect URI (cocok untuk server tanpa public URL).
  - Admin cukup buka link di browser manapun, masukkan 8-digit code.
  - Server poll di background sampai granted.
  - Client ID yang dipakai: `Iv1.b507a08c87ecfe98` (VS Code GitHub Copilot client ID).

---

## Checklist Tugas

### Phase 1: Boilerplate & Auth Layer
- [x] Buat file `PLAN.md` ini untuk tracking progress.
- [ ] Buat folder `apps/backend/src/providers/copilot/` dengan struktur:
  ```
  providers/copilot/
  ├── index.ts              # CopilotProvider class (implements IProvider)
  ├── auth/
  │   ├── types.ts           # CopilotAccount, CopilotSessionToken interfaces
  │   ├── storage.ts         # Load/save accounts ke providers/copilot/accounts.json
  │   ├── manager.ts         # Account rotation, scoring, cooldown (mirip antigravity)
  │   ├── device-flow.ts     # GitHub OAuth Device Flow (request code, poll grant)
  │   └── token-exchange.ts  # Session token exchange & caching (Layer 3)
  ├── config/
  │   └── model-specs.ts     # Model registry (copilot:gpt-4o, copilot:claude-sonnet-4, dll)
  └── upstream/
      ├── executor.ts        # Upstream request executor dengan retry & account rotation
      └── headers.ts         # Copilot-specific headers (Editor-Version, User-Agent, dll)
  ```
- [ ] Buat `providers/copilot/` folder di root untuk config file storage (`accounts.json`).
- [ ] Definisikan `CopilotAccount` interface di `auth/types.ts`:
  ```typescript
  interface CopilotAccount {
    id: string;                    // unique identifier (email atau github username)
    providerId: 'copilot';
    personalToken: string;         // ghu_xxx / gho_xxx / GitHub OAuth access_token
    githubUsername?: string;
    email?: string;

    // Session token (Layer 3) - cached, auto-refreshed
    sessionToken?: string;
    sessionTokenExpiresAt?: number;

    // Rotation stats (sama seperti Antigravity)
    healthScore: number;
    lastUsed: number;
    consecutiveFailures?: number;
    cooldowns?: Record<string, number>;
    tokenUsage?: number;
    status: 'active' | 'cooldown' | 'invalid';
  }
  ```

### Phase 2: Device Flow & Token Exchange
- [ ] Implement `auth/device-flow.ts`:
  - `startDeviceFlow()` → POST `https://github.com/login/device/code` → return `{ user_code, device_code, verification_uri, interval }`.
  - `pollDeviceFlow(deviceCode, interval)` → Poll `https://github.com/login/oauth/access_token` sampai status `authorization_pending` → `complete`.
  - Simpan hasil sebagai `personalToken` di `CopilotAccount`.
- [ ] Implement `auth/token-exchange.ts`:
  - `exchangeSessionToken(personalToken)` → GET `https://api.github.com/copilot_internal/v2/token` → return `{ token, expires_at }`.
  - `ensureSessionToken(account)` → Check cache, refresh kalau expired (buffer 60 detik sebelum expiry).
  - Cache session token di memory (tidak perlu persist, karena short-lived).
- [ ] Expose Device Flow via admin route:
  - `POST /api/providers/copilot/accounts/add` → Trigger device flow jika body kosong, atau accept `{ personalToken }` untuk manual paste.
  - `GET /api/providers/copilot/device-status?device_code=xxx` → Poll status untuk frontend.

### Phase 3: Provider Core & Upstream
- [ ] Implement `CopilotProvider` class di `index.ts`:
  - `init()` → Load accounts dari storage, validate personal tokens.
  - `getBestAccount()` → Rotation logic (reuse pattern dari antigravity manager).
  - `updateAccountUsage()` → Scoring & cooldown handling.
  - `execute()` → Core request pipeline:
    1. Get best account → ensure session token ready.
    2. Build request ke `https://api.githubcopilot.com/chat/completions`.
    3. Passthrough body (sudah OpenAI format) untuk protocol `openai`.
    4. Untuk protocol `anthropic`: convert Anthropic format → OpenAI format → kirim → convert response balik.
    5. Stream response langsung ke client (SSE passthrough).
  - `addAccount()` → Support 2 mode: device flow atau manual token paste.
- [ ] Implement `upstream/executor.ts`:
  - Retry logic dengan account rotation (mirip antigravity executor).
  - Handle 401 (token invalid → re-exchange session token → retry).
  - Handle 429 (rate limit → cooldown account → rotate ke akun lain).
- [ ] Implement `upstream/headers.ts`:
  ```typescript
  export function getCopilotHeaders(sessionToken: string) {
    return {
      'Authorization': `Bearer ${sessionToken}`,
      'Content-Type': 'application/json',
      'Editor-Version': 'vscode/1.100.0',
      'Editor-Plugin-Version': 'copilot/1.250.0',
      'User-Agent': 'GithubCopilot/1.250.0',
      'Copilot-Integration-Id': 'vscode-chat',
      'Openai-Intent': 'conversation-panel',
    };
  }
  ```

### Phase 4: Model Registry
- [ ] Implement `config/model-specs.ts` dengan model mapping:
  ```
  copilot:gpt-4o          → gpt-4o (pool: cli)
  copilot:gpt-4.1         → gpt-4.1 (pool: cli)
  copilot:claude-sonnet-4 → claude-sonnet-4 (pool: cli)
  copilot:claude-3.5-sonnet → claude-3.5-sonnet (pool: cli)
  copilot:gemini-2.5-pro  → gemini-2.5-pro (pool: cli)
  copilot:o3              → o3 (pool: cli, thinking: true)
  copilot:o4-mini         → o4-mini (pool: cli, thinking: true)
  ```
  > Note: Model list bisa berubah seiring update Copilot. Fetch dari `/models` endpoint jika memungkinkan.

### Phase 5: Registrasi & Integrasi
- [ ] Register `CopilotProvider` di `apps/backend/src/server.ts`:
  ```typescript
  import { CopilotProvider } from "@/providers/copilot";

  const copilotProvider = new CopilotProvider();
  await copilotProvider.init();
  registerProvider(copilotProvider);
  ```
- [ ] Update admin router jika perlu route khusus device flow (atau gunakan existing `/api/providers/:id/accounts/add`).
- [ ] Pastikan `model-resolver` bisa resolve prefix `copilot:` dengan benar.

### Phase 6: Testing & Verifikasi
- [ ] Integration test: kirim request dengan model `copilot:gpt-4o` dan verifikasi response stream.
- [ ] Test token exchange lifecycle: fresh token → cache → expiry → auto-refresh.
- [ ] Test error scenarios:
  - Token invalid (401) → account marked invalid.
  - Rate limit (429) → cooldown triggered, rotate ke akun lain.
  - Session token expired mid-request → re-exchange dan retry.
- [ ] Test device flow end-to-end dari dashboard.
- [ ] Verifikasi format SSE output kompatibel dengan OpenClaw/client.

---

## Catatan Teknis

### Kenapa Tidak Perlu Complex Mapper?
Copilot upstream (`api.githubcopilot.com/chat/completions`) sudah **100% OpenAI-compatible**:
- Request format = OpenAI chat completions.
- Response format = OpenAI SSE (`data: {"choices": [...]}`).
- Jadi untuk protocol `openai`, kita tinggal passthrough.
- Untuk protocol `anthropic`, kita hanya perlu convert di edge (Anthropic ↔ OpenAI), yang bisa reuse mapper existing atau buat lightweight converter.

### Security Considerations
- Personal token (`ghu_*`) harus di-encrypt at rest di `accounts.json` (future improvement).
- Session token hanya di-cache di memory, tidak di-persist.
- Device flow memiliki timeout bawaan (~15 menit) dari GitHub.
- Rate limit per-account, bukan per-IP — jadi multi-account rotation efektif.

### Limitasi yang Diketahui
- Copilot bisa enforce model availability berdasarkan subscription tier (Individual vs Business vs Enterprise).
- Beberapa model mungkin punya rate limit lebih ketat (misal thinking models).
- GitHub bisa update/revoke client ID kapan saja.
