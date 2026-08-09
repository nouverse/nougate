# Nougate vs Antigravity-Manager — Gap Analysis

Perbandingan dengan [Antigravity-Manager](https://github.com/lbjlaq/Antigravity-Manager)
(Rust/Axum, desktop app Tauri), yang jadi acuan awal saat proxy ini masih single-provider.

> [!IMPORTANT]
> **Diperbarui Agustus 2026 terhadap kode yang berjalan sekarang.** Baris-baris di bawah
> diverifikasi langsung ke `apps/backend/src/`, bukan disalin dari revisi sebelumnya.
> Referensi `REF:` menunjuk ke `tmp/antigravity-manager/src-tauri/src/proxy/` (v4.3.0) dan
> hanya relevan kalau source itu masih ada di mesin kamu.

> [!NOTE]
> **Perbandingannya sudah tidak apple-to-apple.** Manager adalah desktop app untuk
> mengelola akun Antigravity/Google. Nougate sekarang gateway multi-provider yang
> dioperasikan satu tim: Antigravity cuma salah satu plugin di antara Copilot dan custom
> provider tanpa batas. Sebagian besar "kekalahan" yang tersisa ada di kedalaman
> Antigravity-specific — persis area yang Manager jadikan seluruh produknya.

---

## Ringkasan: sekarang di mana posisi kita

**Menang telak di lapisan gateway.** Multi-provider, dua protokol klien penuh dua arah,
observability berbasis database dengan biaya per key, autentikasi dashboard dan gateway,
dan model kapabilitas yang membuat provider baru tidak menyentuh core. Manager tidak punya
satu pun dari ini — bukan karena kalah, tapi karena bukan itu produknya.

**Sisa gap tinggal dua**, setelah rate limiting per-model, kalibrator estimasi, error
classifier, dan pemilihan akun sadar kuota selesai (Agustus 2026):

1. **Kompresi konteks belum dipicu rasio pemakaian.** Dua lapis kita jalan tiap request.
   Ditunda dengan sengaja: ini fitur *biaya*, bukan stabilitas, dan Gemini punya konteks
   ~1 juta token sehingga batasnya jarang tersentuh.
2. **Tidak ada adapter per-klien**, jadi quirk satu IDE tidak bisa ditangani terpisah.

Di luar daftar Manager, gap terbesar Nougate tetap **cross-provider fallback** — lihat
[COMPARISON.md](COMPARISON.md).

Selain itu ada tiga endpoint yang belum ada — Codex `/v1/responses`, Gemini native, dan
Imagen — yang belum tentu perlu; lihat [§7](#7-rekomendasi-berikutnya).

**Yang sengaja tidak diadopsi** ada di [§6](#6-sengaja-tidak-diadopsi) — bukan backlog.

---

## 1. Gap Analysis

Legenda: ⬆️ kita lebih baik · 🟰 setara · ⬇️ kita masih kalah · ➖ di luar scope kita

### Lapisan gateway — area yang tidak dimiliki Manager

| Fitur | Nougate | Antigravity-Manager | Assessment |
|-------|:-------:|:-------------------:|:----------:|
| Multi-provider dalam satu gateway | ✅ Antigravity + Copilot + custom tanpa batas | ❌ Antigravity/Google saja | ⬆️ **Better** |
| Provider sebagai plugin (kontrak `IProvider`) | ✅ core tidak pernah tahu nama provider | ❌ single-purpose | ⬆️ **Better** |
| Custom provider dari dashboard (tanpa kode) | ✅ id, base URL, API style, key, model | ❌ | ⬆️ **Better** |
| Model kapabilitas (`getQuotas`, `accountFlow`) | ✅ implement satu method → fitur dashboard nyala | ❌ | ⬆️ **Better** |
| Terjemahan protokol dua arah penuh | ✅ 4 kombinasi OpenAI×Anthropic | 🟡 semua menuju Google | ⬆️ **Better** |
| Database pilihan (SQLite **atau** Postgres) | ✅ satu `DB_URL`, nol cabang di kode | 🟡 SQLite (desktop) | ⬆️ **Better** |
| Biaya & harga (price book + unpriced badge) | ✅ per request, per model, per key | ❌ token saja | ⬆️ **Better** |
| Atribusi per gateway API key (90 hari) | ✅ ikut ke rollup harian | ❌ | ⬆️ **Better** |
| Auth dashboard (user, argon2id, sesi) | ✅ selalu aktif | 🟡 desktop app, tidak relevan | ⬆️ **Better** |
| Attribusi kompresi per engine | ✅ diukur antar-pass | ❌ | ⬆️ **Better** |
| API Playground | ✅ jalur nyata, bukan simulasi | ❌ | ⬆️ **Better** |

### Inti proxy — area yang dulu jadi acuan

| Fitur | Nougate | Antigravity-Manager | Assessment | Section |
|-------|:-------:|:-------------------:|:----------:|:-------:|
| OpenAI-compatible endpoint | ✅ | ✅ | 🟰 Setara | — |
| Anthropic native `/v1/messages` | ✅ | ✅ | 🟰 Setara | [§2.1](#21--native-anthropic-endpoint-v1messages) |
| Multi-layer signature cache | ✅ 4-layer | ✅ 4-layer | 🟰 Setara | [§2.2](#22--multi-layer-signature-cache) |
| Tiered account sorting (Ultra/Pro/Free) | ✅ tier + skor per-model + **sisa kuota** | ✅ tier + sisa kuota per-model | 🟰 Setara | [§2.3](#23--tiered-account-sorting) |
| Rate limit + exponential backoff | ✅ | ✅ | 🟰 Setara | [§2.4](#24--model-level-rate-limiting) |
| **Rate limit granularity** | ✅ `pool\|model` + scope account-wide + `UpstreamErrorKind` | ✅ `account:model` + reason enum | 🟰 Setara | [§2.4](#24--model-level-rate-limiting) |
| JSON Schema cleaning untuk Gemini | ✅ | ✅ | 🟰 Setara | [§2.5](#25--json-schema-cleaning-for-gemini) |
| Smart retry delay parsing + grace | ✅ `providers/antigravity/utils/retry.ts` | ✅ | 🟰 Setara | [§2.6](#26--smart-retry-delay-parsing--grace-retry) |
| Session fingerprinting | ✅ SHA256 pesan pertama | ✅ | 🟰 Setara | [§3.6](#36--session-fingerprinting) |
| Model specs dari JSON | ✅ registry + override runtime | ✅ | 🟰 Setara | [§3.12](#312--model-specs-from-json-config) |
| Thinking budget config | ✅ per-model budget/level/mode | ✅ 4 mode | 🟰 Setara | [§3.11](#311--thinking-budget-config) |
| Global system prompt injection | ✅ + Caveman 5 level | ✅ | ⬆️ **Better** | [§3.9](#39--global-system-prompt-injection) |
| Tool result compression | ✅ RTK inline + Headroom | ✅ snapshot/HTML-aware | ⬆️ **Better** | [§3.2](#32--tool-result-compression) |
| Device fingerprint (impersonation) | ✅ header penuh + varian CLI | ✅ | 🟰 Setara | — |
| Debug payload logger | ✅ + filter model | ✅ | 🟰 Setara | [§4.9](#49--debug-payload-logger) |
| OAuth browser flow | ✅ (Antigravity saja, lihat catatan) | ✅ | 🟰 Setara | — |
| **Estimation calibrator** | ✅ smoothed, clamped, persisted | ✅ EMA | 🟰 Setara | [§3.10](#310--estimation-calibrator-self-learning-token-estimation) |
| **Error classifier** | ✅ `core/upstream-errors.ts`, memandu retry/rotate/scope | ✅ + i18n | 🟰 Setara | [§4.8](#48--error-classifier) |
| **Request monitoring / usage stats** | ✅ DB + rollup + dashboard + CSV | ✅ buffer in-memory | ⬆️ **Better** | [§3.4](#34--request-monitoring--usage-stats) |
| **API key auth (multi-token)** | ✅ wajib, hash SHA-256, per-key usage | ✅ token + whitelist | ⬆️ **Better** | [§4.3](#43--api-key-auth-middleware-multi-token) |
| `/v1/models` endpoint | ✅ lintas semua provider | ✅ | ⬆️ **Better** | [§4.1](#41--v1models-endpoint) |

### Yang masih kurang

| Fitur | Nougate | Antigravity-Manager | Assessment | Section |
|-------|:-------:|:-------------------:|:----------:|:-------:|
| Dynamic model routing / wildcard | ❌ | ✅ exact + wildcard + specificity | ⬇️ Worse | [§3.1](#31--dynamic-model-routing) |
| Background task silent downgrade | ❌ | ✅ reroute ke Flash | ⬇️ Worse | [§3.1](#31--dynamic-model-routing) |
| Context purification bertingkat | 🟡 strip thinking turn lama | ✅ soft/aggressive + estimasi token | ⬇️ Worse | [§3.3](#33--context-purification) |
| Multi-level context compression | 🟡 2 lapis, tanpa threshold otomatis | ✅ L1/L2/L3 by usage ratio | ⬇️ Worse | [§3.8](#38--multi-level-context-compression) |
| Client adapter system | ❌ user-agent hanya di-log | ✅ perilaku per-IDE | ⬇️ Worse | [§3.7](#37--client-adapter-system) |
| Codex `/v1/responses` | ❌ | ✅ | ⬇️ Worse | [§3.5](#35--codex--responses-endpoint) |
| Gemini native endpoint | ❌ | ✅ | ⬇️ Worse | — |
| Imagen 3 `/v1/images/generations` | ❌ | ✅ | ⬇️ Worse | [§4.2](#42--imagen-3-support) |
| Account warmup | ❌ | ✅ pre-flight validation | ⬇️ Worse | [§4.5](#45--account-warmup) |
| Quota scheduler | ❌ | ✅ scan + auto-warmup | ⬇️ Worse | [§4.10](#410--quota-scheduler) |
| Tool artifact store | ❌ | ✅ sidecar store | ⬇️ Worse | [§4.7](#47--tool-artifact-store) |
| HTTP session store (Codex) | ❌ | ✅ | ⬇️ Worse | [§4.11](#411--http-session-store-codex) |
| IP whitelist/blacklist | ❌ | ✅ | ➖ Lihat §6 | [§4.4](#44--ip-whitelistblacklist) |
| Outbound proxy pool | ❌ | ✅ | ➖ Lihat §6 | [§4.6](#46--outbound-proxy-pool) |

> **Catatan OAuth.** Alur redirect kita masih hardcoded ke Antigravity
> (`/oauth/start` + `/oauth-callback` di `router/admin.ts`). Provider kedua yang butuh
> redirect OAuth harus menggeneralisasi dua route itu dulu — detailnya di
> [ARCHITECTURE.md §10](ARCHITECTURE.md#10-known-gap-browser-redirect-oauth-is-not-yet-agnostic).
> Device flow dan API key sudah provider-agnostic.

---

## 2. Prioritas tinggi — semua sudah terpasang kecuali satu

Bagian ini dulu berisi rencana. Sekarang hampir seluruhnya sudah ada di kode; teks
aslinya dipertahankan sebagai catatan asal-usul, dengan status di setiap sub-bagian.

### 2.1 🔴 Native Anthropic Endpoint (`/v1/messages`)

> **Status: ✅ selesai.** `protocols/anthropic/` menangani `/anthropic/v1/messages` dan `/anthropic/v1/models`, streaming maupun tidak. Mapper-nya di `core/mappers/` dan dipakai semua provider, bukan cuma Antigravity.

**Mengapa penting:** Claude Code CLI dan banyak tool AI lain menggunakan format Anthropic langsung, bukan OpenAI format. Tanpa ini, user harus selalu menggunakan wrapper/shim.

**Referensi kode:**

| File (REF:) | Ukuran | Fungsi |
|-------------|--------|--------|
| `handlers/claude.rs` | 90KB, 1740 lines | Handler utama |
| `mappers/claude/request.rs` | 132KB, 2089 lines | Anthropic → Google transform |
| `mappers/claude/streaming.rs` | 50KB, 1262 lines | Google → Anthropic SSE transform |
| `mappers/claude/models.rs` | 13KB, 384 lines | Struct definitions |
| `mappers/claude/thinking_utils.rs` | 10KB, 284 lines | Thinking block handling |
| `mappers/claude/utils.rs` | 6.6KB, 182 lines | Helper utilities |

**Key methods:**
```
handlers/claude.rs:
  L249  pub async fn handle_messages()          — Main /v1/messages handler
  L1698 pub async fn handle_list_models()       — GET /v1/models/claude
  L1722 pub async fn handle_count_tokens()      — POST /v1/messages/count_tokens

mappers/claude/request.rs:
  L334  pub fn transform_claude_request_in()    — Convert Claude → Google Gemini body
  L76   pub fn clean_cache_control_from_messages() — Strip cache_control from messages
  L258  pub fn merge_consecutive_messages()     — Merge same-role consecutive messages
  L2067 pub fn clean_thinking_fields_recursive() — Strip thinking from JSON recursively

mappers/claude/streaming.rs:
  L15   pub fn remap_function_call_args()       — Fix tool call arg format
  L177  pub struct SignatureManager             — Per-stream signature tracking
  L202  pub struct StreamingState               — SSE stream state machine
```

**Implementasi di proxy kita:**
```
src/
├── handlers/
│   ├── openai.ts         # /v1/chat/completions (existing logic)
│   └── anthropic.ts      # /v1/messages (NEW)
├── mappers/
│   ├── openai-to-google.ts   # OpenAI → Google transform (existing)
│   └── anthropic-to-google.ts # Anthropic → Google transform (NEW)
```

**Scope:**
- `POST /v1/messages` — streaming & non-streaming
- Transform Anthropic message format → Google Gemini format
- Transform Google response → Anthropic SSE events (`message_start`, `content_block_delta`, `message_stop`)
- Support `system` prompt extraction ke `system_instruction`
- Support `thinking` content blocks (extended thinking)
- Support tool_use / tool_result

---

### 2.2 🔴 Multi-Layer Signature Cache

> **Status: ✅ selesai.** Keempat layer ada, termasuk rewind detection. Cache disimpan di `data/signatures.json`.

**Mengapa penting:** Cache signature kita saat ini hanya 2-layer (thought text → signature, call ID → signature). Antigravity-Manager menggunakan **4-layer** yang lebih robust:

| Layer | Key | Value | Fungsi |
|-------|-----|-------|--------|
| 1 | `tool_use_id` | signature | Recover signature saat client strip |
| 2 | `signature` | model family | Cegah cross-model signature contamination |
| 3 | `session_id` | latest signature + msg_count | Cegah cross-session pollution + rewind detection |
| 4 | `session_id` | reasoning text per turn | Cache reasoning untuk re-inject saat retry |

**Referensi kode:**

| File (REF:) | Ukuran | Fungsi |
|-------------|--------|--------|
| `signature_cache.rs` | 17KB, 466 lines | Core 4-layer signature cache |
| `mappers/signature_store.rs` | 3.3KB, 69 lines | Global thread-local signature store |

**Key methods (signature_cache.rs):**
```
L45   pub struct SignatureCache                 — Main struct (4 internal HashMaps)
L79   pub fn global()                          — Global singleton accessor
L6    const SIGNATURE_TTL: Duration = 2 hours  — Cache TTL

--- Layer 1: Tool Signatures ---
L85   pub fn cache_tool_signature(tool_use_id, signature)
L114  pub fn get_tool_signature(tool_use_id) -> Option<String>
L10   const TOOL_CACHE_LIMIT: usize = 500

--- Layer 2: Model Family ---
L130  pub fn cache_thinking_family(signature, family)
L159  pub fn get_signature_family(signature) -> Option<String>
L11   const FAMILY_CACHE_LIMIT: usize = 200

--- Layer 3: Session Signature ---
L181  pub fn cache_session_signature(session_id, signature, message_count)
L253  pub fn get_session_signature(session_id) -> Option<String>
L12   const SESSION_CACHE_LIMIT: usize = 1000
L197  // Rewind detection: if message_count < existing → force update

--- Layer 4: Session Reasoning ---
L272  pub fn cache_session_reasoning(session_id, reasoning, turn_index)
L319  pub fn get_session_reasoning(session_id, turn_index) -> Option<String>
```

**Key methods (signature_store.rs):**
```
L18   pub fn store_thought_signature(sig)      — Store to thread-local
L43   pub fn get_thought_signature()            — Read without consuming
L53   pub fn take_thought_signature()           — Read and consume (take)
L63   pub fn clear_thought_signature()          — Clear thread-local
```

**Key methods (openai/streaming.rs — signature integration):**
```
L12   pub fn store_thought_signature(sig, session_id, message_count)
      — Stores to both SignatureCache (Layer 3) and thread-local signature_store
```

**Yang kita belum punya:**
- Layer 2 (model family tracking) — mencegah pakai signature Claude untuk request Gemini
- Layer 3 (session-based + rewind detection) — deteksi kalau user delete message lalu kirim ulang
- Layer 4 (reasoning text cache per turn) — untuk recovery saat retry

**Implementasi:**
- Tambah `signatureFamilyCache: Map<signature, modelFamily>` di `cache.ts`
- Tambah `sessionSignatureCache: Map<sessionId, { signature, messageCount }>` di `cache.ts`
- Tambah rewind detection logic: jika `messageCount` request baru < cached messageCount → force update signature
- TTL: 2 jam (sama seperti Manager)
- Min signature length validation: 50 chars

---

### 2.3 🔴 Tiered Account Sorting

> **Status: ✅ selesai (Agustus 2026).** Skor rotasi sekarang menggabungkan empat sinyal:
> health (reaktif), least-recently-used, tier ultra/pro/free (+30/+15/0), dan **sisa kuota**
> untuk model yang diminta (`scoring.weights.quota`, default 25).
>
> Kuota memakai limit paling buruk yang relevan — akun yang aman di satu limit tapi habis di
> limit lain tetap tidak bisa melayani. Akun yang providernya tidak melaporkan kuota
> mendapat 0, yaitu peringkat yang persis sama seperti sebelum dimensi ini ada; nilai `null`
> berarti "tidak ada pendapat", bukan "kosong", supaya menambah akun baru tidak membuat pool
> terlihat habis. Set `weights.quota: 0` untuk mematikannya.
>
> Bobotnya sengaja di bawah selisih health yang berarti: kuota penuh bernilai +25, sedangkan
> selisih 20 poin health bernilai +40. Peringkat tetap didominasi oleh apakah akun benar-benar
> jalan.

**Mengapa penting:** Saat ini kita rotasi berdasarkan health score saja. Antigravity-Manager mengurutkan akun dengan **4 level priority**:

```
Priority 0: Subscription Tier (ULTRA > PRO > FREE)
Priority 1: Model-specific quota (higher remaining % = higher priority)
Priority 2: Health score (higher = better)
Priority 3: Reset time (sooner reset = higher priority, konsumsi dulu yang segera refresh)
```

**Referensi kode:**

| File (REF:) | Ukuran | Fungsi |
|-------------|--------|--------|
| `token_manager.rs` | 161KB, 3992 lines | Account pool + tiered sorting |

**Key structs & methods (token_manager.rs):**
```
--- Account struct ---
L20   pub struct ProxyToken {
L22       pub access_token: String,
L29       pub subscription_tier: Option<String>,  // "FREE" | "PRO" | "ULTRA"
L30       pub remaining_quota: Option<i32>,
L32       pub health_score: f32,                  // 0.0 - 1.0
L33       pub reset_time: Option<i64>,            // Quota refresh timestamp
L37       pub model_quotas: HashMap<String, i32>, // Per-model quota cache
L38       pub model_limits: HashMap<String, u64>, // Per-model max_output_tokens
      }

--- Sorting logic ---
L1254 tokens_snapshot.sort_by(|a, b| {
L1259     let tier_priority = |tier| {
L1261         if t.contains("ultra") { 0 }        // Priority 0
L1263         else if t.contains("pro") { 1 }
L1265         else if t.contains("free") { 2 }
L1267         else { 3 }
          };
L1272     // Compare tier first
L1280     // Then compare model-specific quota
L1289     // Then compare health_score
      });

--- Token selection ---
L1161 pub async fn get_token(session_id, model, force_rotate) -> Result<ProxyToken>
L128  pub async fn load_accounts() -> Result<usize>
L176  pub async fn reload_account(account_id) -> Result<()>
L855  pub async fn resolve_dynamic_model_for_account() — Per-account model resolution
```

**Implementasi di `manager.ts`:**
- Tambah field `subscriptionTier` ke account config (detected via quota API response field `subscription_tier`)
- Tambah field `modelQuotas: Record<string, number>` per account
- Ubah sorting di `getNextAccount()` dari single-dimension (health) ke multi-dimension
- Akun dengan remaining quota tertinggi untuk model yang diminta diprioritaskan

---

### 2.4 🔴 Model-Level Rate Limiting

> **Status: ✅ selesai (Agustus 2026), sekaligus memperbaiki dua bug.**
>
> Cooldown sekarang berkunci pada `pool|model`, dengan satu scope `*` untuk
> "bench seluruh akun"; setiap pengecekan menghormati keduanya. Alasannya direkam
> sebagai `UpstreamErrorKind` dari `core/upstream-errors.ts`.
>
> Dua bug yang ikut ketahuan dan diperbaiki:
> - **Copilot**: cooldown ditulis dengan model id tapi dibaca dengan nama family, jadi
>   lock-nya tidak pernah terlihat dan akun langsung dipilih lagi setelah 429.
> - **Antigravity**: `markAccountCooldown` mengirim 3 argumen ke fungsi 4 parameter,
>   sehingga `"3600s"` mendarat di slot scope — tombol Cooldown di dashboard menulis kunci
>   yang tidak pernah dibaca dan memakai durasi default.
>
> Family lama bernama `Claude/GPT`, jadi satu limit pada Claude Opus ikut membekukan model
> GPT di akun yang sama.

**Mengapa penting:** Saat ini rate limit kita hanya per-account. Tapi Google bisa rate-limit per MODEL per account (misal: akun A kena limit untuk `gemini-3-pro` tapi masih bisa untuk `gemini-3-flash`).

**Referensi kode:**

| File (REF:) | Ukuran | Fungsi |
|-------------|--------|--------|
| `rate_limit.rs` | 28KB, 768 lines | Rate limit tracker + exponential backoff |

**Key structs & methods (rate_limit.rs):**
```
--- Enums & Structs ---
L7    pub enum RateLimitReason {
          QuotaExhausted,           // QUOTA_EXHAUSTED
          RateLimitExceeded,        // RATE_LIMIT_EXCEEDED
          ModelCapacityExhausted,   // MODEL_CAPACITY_EXHAUSTED
          ServerError,              // 5xx
          Unknown,
      }
L23   pub struct RateLimitInfo {
L26       pub reset_time: SystemTime,
L28       pub retry_after_sec: u64,
L34       pub reason: RateLimitReason,
L37       pub model: Option<String>,    // None = account-level, Some = model-level
      }
L45   pub struct RateLimitTracker {
L46       limits: DashMap<String, RateLimitInfo>,
L48       failure_counts: DashMap<String, (u32, SystemTime)>,  // For exponential backoff
      }
L42   const FAILURE_COUNT_EXPIRY_SECONDS: u64 = 3600;         // Reset after 1h without failure

--- Key Methods ---
L62   fn get_limit_key(account_id, model) -> String
      — Returns "account_id" or "account_id:model_id"
L71   pub fn get_remaining_wait(account_id, model) -> u64
      — Checks both account-level AND model-level locks
L106  pub fn mark_success(account_id)
      — Resets failure counter on success
L124  pub fn set_lockout_until(account_id, reset_time, retry_after_sec, reason, model)
      — Sets rate limit lock with reason tracking
L203  pub fn parse_from_error(status, headers, body, account_id, model)
      — Parses 429/503 response to extract retry-after, reason, reset time
L575  pub fn get(account_id) -> Option<RateLimitInfo>
L581  pub fn is_rate_limited(account_id, model) -> bool
L600  pub fn cleanup_expired() -> usize
      — Auto-cleanup called every 15s by background task (token_manager.rs L96)
```

**Key methods in token_manager.rs (rate limit integration):**
```
L2212 pub async fn mark_rate_limited(account_id, model, duration, reason)
L2241 pub async fn is_rate_limited(account_id, model) -> bool
L2295 pub fn mark_account_success(account_id)
L2404 pub fn set_precise_lockout(account_id, reset_iso, model, reason)
L2442 pub async fn fetch_and_lock_with_realtime_quota() — Real-time quota check before lock
```

**Retry strategy (handlers/common.rs):**
```
L30   pub fn determine_retry_strategy(status, headers, body) -> Option<RetryStrategy>
L96   pub async fn apply_retry_strategy(strategy, token_manager, account_id)
L167  pub fn should_rotate_account(status_code, strategy) -> bool
      — Returns true for 429, 401, 403, 503, 529
```

**Implementasi:**
- Ubah rate limit key dari `accountId` menjadi `accountId:modelId`
- Track `RateLimitReason`: quota_exhausted vs rate_limit_exceeded vs server_error
- Exponential backoff: failure counter per account dengan auto-reset setelah 1 jam tanpa failure
- Grace window 1500ms untuk transient errors (503/529)

---

### 2.5 🔴 JSON Schema Cleaning for Gemini

> **Status: ✅ selesai.** Ada di mapper Antigravity.

**Mengapa penting:** Gemini API TIDAK mendukung banyak fitur JSON Schema standar yang tool/MCP declarations gunakan (`$ref`, `$defs`, `additionalProperties`, `anyOf`, `format`, `default`, dll.). Tanpa cleaning, tool calling akan sering gagal dengan error "Invalid schema" yang membingungkan.

**Referensi kode:**

| File (REF:) | Ukuran | Fungsi |
|-------------|--------|--------|
| `common/json_schema.rs` | 61KB, 1669 lines | Recursive JSON Schema cleaner |
| `common/tool_adapter.rs` | 2.7KB, 96 lines | Tool adapter trait |
| `common/tool_adapters/pencil.rs` | 5.5KB | MCP Pencil tool adapter |

**Key methods & constants (json_schema.rs):**
```
--- Constants ---
L8    const CONSTRAINT_FIELDS = [
          ("minLength", "minLen"), ("maxLength", "maxLen"),
          ("pattern", "pattern"), ("minimum", "min"),
          ("maximum", "max"), ("format", "format"), ...
      ]  — Fields stripped but preserved as description hints
L34   const MAX_RECURSION_DEPTH: usize = 10

--- Main entry points ---
L44   pub fn clean_json_schema(value: &mut Value)
      — Recursive cleaner:
        1. Flatten $ref/$defs (resolve references inline)
        2. Remove $schema, additionalProperties, format, default, uniqueItems
        3. Simplify union types: ["string", "null"] → "string"
        4. Simplify anyOf: anyOf[{type:string},{type:null}] → type:string
        5. Lowercase type values (Gemini v1internal requirement)
        6. Convert constraint fields (minLength, pattern, etc.) → description hints
L79   pub fn clean_json_schema_for_tool(value, tool_name)
      — Same as above but with tool-specific adapter pre/post processing
L742  pub fn fix_tool_call_args(args: &mut Value, schema: &Value)
      — Fix AI-generated tool call args to match schema (type coercion, etc.)
```

**Tool Adapter trait (tool_adapter.rs):**
```
L7    pub trait ToolAdapter: Send + Sync {
          fn matches(&self, tool_name: &str) -> bool;
          fn pre_process(&self, schema: &mut Value) -> Result<(), String>;
          fn post_process(&self, schema: &mut Value) -> Result<(), String>;
      }
L45   pub fn append_hint_to_schema(schema, hint)
      — Append hint text to schema description field
```

**Implementasi:**
- Tambah `cleanJsonSchema(schema)` function di `transform.ts`
- Handle: `$ref` flattening, `anyOf` simplification, constraint→description conversion
- Strip: `$schema`, `additionalProperties`, `format`, `default`, `uniqueItems`
- Apply sebelum tool declarations dikirim ke Google API
- CRITICAL: Tanpa ini, MCP tools yang complex (Pencil, filesystem, dll.) akan gagal

---

### 2.6 🔴 Smart Retry Delay Parsing + Grace Retry

> **Status: ✅ selesai.** `providers/antigravity/utils/retry.ts` — `parseRetryDelay()` dengan parsing rekursif dan Google duration object.

**Mengapa penting:** Saat ini kita hanya parse header `Retry-After` yang sederhana. Antigravity-Manager melakukan **deep recursive parsing** dari error body untuk extract delay yang tepat, dan menambahkan "grace window" 1.5s.

**Referensi kode:**

| File (REF:) | Ukuran | Fungsi |
|-------------|--------|--------|
| `upstream/retry.rs` | 6KB, 192 lines | Smart retry delay parser |

**Key methods & constants (retry.rs):**
```
--- Duration Parser ---
L7    static DURATION_RE: Regex = r"([\d.]+)\s*(ms|s|m|h)"
L34   pub fn parse_duration_ms(duration_str) -> Option<u64>
      — Parse "1.5s", "200ms", "1h16m0.667s" → milliseconds

--- Retry Delay Extraction ---
L60   pub fn parse_retry_delay(error_text) -> Option<u64>
      — 3-stage parsing:
        1. Regex: "quota will reset after X" / "retry after X"
        2. Structured JSON: recursive scan for retryDelay/quotaResetDelay keys
        3. Google Duration object: {seconds: 1, nanos: 500000000}
      — Adds 1500ms grace window to all parsed delays

L128  fn parse_structured_duration_object(value) -> Option<u64>
      — Parse Google's {"seconds": 1, "nanos": 0} format

--- Grace Retry Decision ---
L161  pub fn should_grace_retry(duration_ms) -> bool
      — If delay ≤ 2000ms: retry IN-PLACE (don't rotate account)
      — If delay > 2000ms: rotate to next account
```

**Implementasi:**
- Tambah `parseRetryDelay(errorBody)` di `utils/`
- Parse dari: regex patterns, recursive JSON, Google duration objects
- Grace window: tambah 1.5s ke semua parsed delays
- Grace retry: kalau delay ≤ 2s, sleep dan retry di akun yang sama (jangan rotasi)
- Ini akan significantly reduce unnecessary account rotations

---

## 3. Prioritas medium — campuran

Sebagian sudah selesai dan melampaui referensinya (§3.2, §3.4, §3.9), sebagian masih
kosong (§3.1, §3.7, §3.10). Status ada di tiap sub-bagian.

### 3.1 🟡 Dynamic Model Routing

> **Status: ❌ belum ada.** Tidak ada `model-routes.json`, tidak ada wildcard matching, tidak ada background-task downgrade. Model diselesaikan lewat prefix `provider:model` yang eksplisit — yang lebih tegas untuk gateway multi-provider, tapi tetap bukan pengganti alias routing.

**Saat ini:** Model mapping di-hardcode di `transform.ts` (`antigravity-` prefix stripping saja).

**Referensi kode:**

| File (REF:) | Ukuran | Fungsi |
|-------------|--------|--------|
| `mappers/common_utils.rs` | 35KB, 939 lines | Request config resolution + model routing |

**Key methods (common_utils.rs):**
```
L8    pub struct RequestConfig {
L9        pub request_type: String,       // "agent" | "web_search" | "image_gen"
L10       pub inject_google_search: bool,
L13       pub final_model: String,
L16       pub image_config: Option<Value>,
      }
L19   pub fn resolve_request_config(original_model, mapped_model, tools, size, quality, ...)
      — Determines request type, injects google search tool, resolves image config
L367  pub fn inject_google_search_tool(body, mapped_model)
      — Injects googleSearch tool declaration into request body
L434  pub fn detects_networking_tool(tools) -> bool
      — Detects web_search/browser/fetch in tool list
L501  pub fn contains_non_networking_tool(tools) -> bool
```

**Antigravity-Manager punya:**
- Configurable model alias mapping via JSON/GUI
- Regex-based matching
- Background task detection → auto reroute ke Flash model (hemat quota Pro)

**Implementasi:**
```jsonc
// config/model-routes.json
{
  "routes": [
    { "match": "gpt-4.*", "target": "gemini-3-pro-thinking" },
    { "match": "claude-.*-sonnet", "target": "claude-sonnet-4-20250514" },
    { "match": ".*", "target": "gemini-3-flash" }
  ],
  "backgroundPatterns": [
    "generate.*title",
    "summarize",
    "classify"
  ],
  "backgroundTarget": "gemini-3-flash"
}
```

---

### 3.2 🟡 Tool Result Compression

> **Status: ✅ selesai dan lebih jauh.** RTK inline plus Headroom opsional, dan sejak Agustus 2026 penghematannya **diatribusikan per engine** — Manager hanya melaporkan satu total.

**Mengapa penting:** Client IDE sering mengirim tool results yang sangat besar (file content, browser snapshots 100KB+). Ini bisa menyebabkan "Prompt is too long" error.

**Referensi kode:**

| File (REF:) | Ukuran | Fungsi |
|-------------|--------|--------|
| `mappers/tool_result_compressor.rs` | 13KB, 410 lines | Smart tool result compression |

**Key methods & constants (tool_result_compressor.rs):**
```
--- Constants ---
L13   const MAX_TOOL_RESULT_CHARS: usize = 200_000;       // Max total chars
L16   const SNAPSHOT_DETECTION_THRESHOLD: usize = 20_000;  // Detect browser snapshot
L19   const SNAPSHOT_MAX_CHARS: usize = 16_000;            // Max snapshot output
L22   const SNAPSHOT_HEAD_RATIO: f64 = 0.7;                // Keep 70% head
L26   const SNAPSHOT_TAIL_RATIO: f64 = 0.3;                // Keep 30% tail

--- Methods ---
L34   pub fn compact_tool_result_text(text, max_chars) -> String
      — Main entry: detects content type, applies best compression strategy
      — Strategy 1: Large file notice → extract key info
      — Strategy 2: Browser snapshot → head+tail preservation
      — Strategy 3: Generic → simple truncation
L284  pub fn sanitize_tool_result_blocks(blocks: &mut Vec<Value>)
      — Sanitize tool result content blocks (strip invalid JSON, etc.)
```

**Internal helpers (private fns):**
```
L39-51  — HTML detection + deep_clean_html() pre-processing
L58     — compact_saved_output_notice() for file output patterns
L70     — compact_browser_snapshot() for <html>/<body> content
L80     — Generic truncation fallback
```

**Implementasi:** Tambah `compressToolResult()` di `transform.ts` yang dijalankan sebelum mengirim ke Google API.

---

### 3.3 🟡 Context Purification

> **Status: 🟡 sebagian.** Thinking dari turn sebelumnya di-strip, tapi belum ada mode soft/aggressive dan belum ada auto-switch berbasis estimasi token.

**Mengapa penting:** Saat conversation history panjang, thinking blocks dari turn-turn sebelumnya memakan banyak token tanpa value.

**Referensi kode:**

| File (REF:) | Ukuran | Fungsi |
|-------------|--------|--------|
| `mappers/context_manager.rs` | 25KB, 706 lines | Context purification + token estimation |

**Key structs & methods (context_manager.rs):**
```
--- Token Estimation ---
L16   fn estimate_tokens_from_str(s) -> u32
      — ASCII: ~4 chars/token, Unicode/CJK: ~1.5 chars/token + 15% safety margin

--- Purification Strategies ---
L42   pub enum PurificationStrategy {
          Soft,        // Keep last ~2 turns of thinking
          Aggressive,  // Remove ALL thinking blocks
      }

--- Claude Format ---
L58   pub fn purify_history(messages, strategy) -> bool
      — Remove thinking blocks from Claude message history
L110  pub fn estimate_token_usage(request: &ClaudeRequest) -> u32
      — Estimate total tokens (system + messages + tools)
L216  pub fn compress_thinking_preserve_signature(messages) -> bool
      — Compress thinking but keep signatures intact
L284  pub fn extract_last_valid_signature(messages) -> Option<String>
      — Find the last valid signature in history
L325  pub fn trim_tool_messages(messages, keep_last_n_rounds) -> bool
      — Trim old tool call/result pairs

--- OpenAI Format ---
L362  pub fn restore_openai_reasoning_content(messages, session_id)
      — Restore reasoning_content from session cache (Layer 4)
L388  pub fn purify_openai_history(messages, strategy) -> bool
      — Remove reasoning_content from OpenAI messages
L418  pub fn trim_openai_tool_messages(messages, keep_last_n_rounds) -> bool
      — Trim old tool call/result pairs from OpenAI format
```

**Antigravity-Manager strategy:**
- **Soft purification**: Hapus thinking blocks kecuali 2 turn terakhir
- **Aggressive purification**: Hapus SEMUA thinking blocks
- Token estimation: `ASCII / 4 + Unicode / 1.5 + 15% safety margin`

**Implementasi:** Kita sudah partial (strip thinking dari previous turns). Yang perlu ditambah:
- Token estimation function
- Auto-switch ke aggressive mode jika estimated tokens > threshold (misal 900K)
- Log jumlah token yang dihemat

---

### 3.4 🟡 Request Monitoring & Usage Stats

> **Status: ✅ selesai dan jauh melampaui.** Bukan circular buffer in-memory seperti rencana awal, melainkan SQLite/Postgres via Drizzle: per-request log, rollup harian 90 hari, biaya per model/provider/client/API key, ekspor CSV, dan dashboard React. Catatan "lightweight, tanpa SQLite" di bawah sudah tidak berlaku — keputusan itu dibalik dengan sengaja.

**Mengapa penting:** Saat ini kita tidak punya visibilitas berapa request sukses/gagal, latency, model mana yang paling sering dipakai.

**Referensi kode:**

| File (REF:) | Ukuran | Fungsi |
|-------------|--------|--------|
| `monitor.rs` | 9.6KB, 265 lines | Request logging + stats aggregation |
| `middleware/monitor.rs` | 29KB, ~750 lines | Middleware yang intercept semua request |

**Key structs & methods (monitor.rs):**
```
L8    pub struct ProxyRequestLog {
L10       pub timestamp: i64,
L13       pub status: u16,
L14       pub duration: u64,          // ms
L15       pub model: Option<String>,
L16       pub mapped_model: Option<String>,
L17       pub account_email: Option<String>,
L18       pub client_ip: Option<String>,
L19       pub error: Option<String>,
L22       pub input_tokens: Option<u32>,
L23       pub output_tokens: Option<u32>,
L24       pub protocol: Option<String>, // "openai" | "anthropic" | "gemini"
L25       pub username: Option<String>,
      }
L29   pub struct ProxyStats {
L30       pub total_requests: u64,
L31       pub success_count: u64,
L32       pub error_count: u64,
      }
L35   pub struct ProxyMonitor {
L36       pub logs: RwLock<VecDeque<ProxyRequestLog>>, // Circular buffer
L37       pub stats: RwLock<ProxyStats>,
L38       pub max_logs: usize,
      }
L81   pub async fn log_request(log: ProxyRequestLog)
L192  pub async fn get_logs(limit: usize) -> Vec<ProxyRequestLog>
L213  pub async fn get_stats() -> ProxyStats
L229  pub async fn get_logs_filtered(filter) -> Vec<ProxyRequestLog>
```

**Admin stats endpoints (server.rs):**
```
L554  .route("/stats/summary", get(admin_get_token_stats_summary))
L555  .route("/stats/hourly", get(admin_get_token_stats_hourly))
L556  .route("/stats/daily", get(admin_get_token_stats_daily))
L557  .route("/stats/weekly", get(admin_get_token_stats_weekly))
L558  .route("/stats/accounts", get(admin_get_token_stats_by_account))
L559  .route("/stats/models", get(admin_get_token_stats_by_model))
```

**Rencana awal (dibatalkan):** circular buffer in-memory, persist ke file tiap 5 menit,
tanpa SQLite.

**Yang benar-benar dibangun:** `core/metrics/` di atas Drizzle — `token_usage_logs` per
request, `token_usage_daily_rollups` harian, penulisan ter-buffer agar tidak pernah
memblokir respons, harga dari price book, dan endpoint
`/api/metrics/{token-usage,recent,export,maintenance}`. Keputusan "no SQLite" dibalik
karena pertanyaan yang ingin dijawab — biaya per key selama 90 hari — memang butuh
agregasi, bukan buffer.

---

### 3.5 🟡 Codex / Responses Endpoint

> **Status: ❌ belum ada.** Tidak ada `/v1/responses`.

**Mengapa penting:** OpenAI Codex CLI menggunakan `POST /v1/responses` yang format-nya berbeda dari `/v1/chat/completions`.

**Referensi kode:**

| File (REF:) | Ukuran | Fungsi |
|-------------|--------|--------|
| `handlers/openai.rs` | 173KB, 4044 lines | OpenAI handler (includes Codex) |
| `mappers/openai/streaming.rs` | 64KB, ~1500 lines | SSE stream builders |

**Key methods:**
```
handlers/openai.rs:
  L28   pub async fn handle_chat_completions()       — /v1/chat/completions handler
  L947  pub async fn handle_completions()             — /v1/completions (legacy) + /v1/responses
  L2079 pub async fn handle_list_models()             — GET /v1/models
  L2245 pub async fn handle_images_generations()      — POST /v1/images/generations
  L3063 pub async fn handle_responses_websocket()     — WebSocket upgrade for /v1/responses
  L3015 pub fn get_cached_tool_call(call_id)          — Codex tool call cache
  L3033 pub fn insert_cached_tool_call(call_id, item) — Cache tool call for Codex

mappers/openai/streaming.rs:
  L72   pub fn create_openai_sse_stream()     — Standard OpenAI SSE stream builder
  L340  pub fn create_legacy_sse_stream()     — Legacy completions SSE
  L462  pub fn create_codex_sse_stream()      — Codex-specific SSE events:
        — response.output_item.added (type: function_call)
        — response.function_call_arguments.delta
        — response.function_call_arguments.done
        — response.output_item.done
        — response.completed

mappers/openai/request.rs:
  L109  pub fn transform_openai_request()    — OpenAI → Google Gemini body transform

mappers/openai/models.rs:                   — OpenAI request/response struct definitions
mappers/openai/collector.rs:                — Response token counting & aggregation
```

**Implementasi:**
- `POST /v1/responses` → transform ke format internal, forward ke Google
- SSE events: `response.output_item.added`, `response.function_call_arguments.delta`, `response.completed`

---

### 3.6 🟡 Session Fingerprinting

> **Status: ✅ selesai.** `buildSessionId()` di handler OpenAI.

**Mengapa penting:** Saat ini kita generate session ID dari `x-client-id` header yang dikirim client. Antigravity-Manager generate **stable session fingerprint** dari SHA256 hash of the first user message, sehingga session tetap konsisten meskipun client tidak mengirim session ID.

**Referensi kode:**

| File (REF:) | Ukuran | Fungsi |
|-------------|--------|--------|
| `session_manager.rs` | 6.5KB, 172 lines | Session fingerprint generator |

**Key methods (session_manager.rs):**
```
L7    pub struct SessionManager;
L20   pub fn extract_session_id(request: &ClaudeRequest) -> String
      — Priority: 1) metadata.user_id, 2) SHA256 of first user message
      — Min text length: 3 chars (lowered from 10 for short messages)
      — Excludes system-injected messages (<system-reminder>, [System)
      — Output format: "sid-{hash[..16]}"
L87   pub fn extract_openai_session_id(request: &OpenAIRequest) -> String
      — Same logic for OpenAI format messages
L132  pub fn extract_gemini_session_id(request: &Value, model_name) -> String
      — Same logic for raw Gemini JSON
```

**Implementasi:** Pindahkan session ID generation ke content-based fingerprint. Ini enable:
- Stable session tracking tanpa butuh client header
- Better signature cache hit rate (Layer 3)
- Account stickiness per conversation

---

### 3.7 🟡 Client Adapter System

> **Status: ❌ belum ada.** `user-agent` hanya masuk log (`router/middleware.ts:84`), tidak mengubah perilaku apa pun.

**Mengapa penting:** Tiap IDE/CLI client punya quirks berbeda. Zed, Claude Code, opencode, Cherry Studio, dll. punya behavior yang berbeda soal signature handling, retry behavior, dan required headers.

**Referensi kode:**

| File (REF:) | Ukuran | Fungsi |
|-------------|--------|--------|
| `common/client_adapter.rs` | 4.3KB, 152 lines | ClientAdapter trait + registry |
| `common/client_adapters/opencode.rs` | 3.6KB, 129 lines | Opencode CLI adapter |

**Key trait (client_adapter.rs):**
```
L15   pub trait ClientAdapter: Send + Sync {
          fn matches(&self, headers: &HeaderMap) -> bool;
          fn bypass_signature_matching(&self) -> bool;  // Default: false
          fn let_it_crash(&self) -> bool;               // Default: false (fast-fail)
          fn signature_buffer_strategy(&self) -> SignatureBufferStrategy; // FIFO/LIFO
          fn inject_beta_headers(&self, headers: &mut HeaderMap);
          fn supported_protocols(&self) -> Vec<Protocol>;
      }
L65   pub enum SignatureBufferStrategy { Default, Fifo, Lifo }
L78   pub enum Protocol { Anthropic, OpenAI, OACompatible, GoogleGemini }
L88   pub static CLIENT_ADAPTERS: Lazy<Vec<Arc<dyn ClientAdapter>>>
      — Global registry, checked on every request
L97   pub fn get_user_agent(headers) -> Option<String>
```

**Opencode adapter example (opencode.rs):**
```
L18   pub struct OpencodeAdapter;
      — matches: user-agent contains "opencode"
      — let_it_crash: true (reduce unnecessary retries)
      — signature_buffer_strategy: FIFO (multi-concurrent tool calls)
      — inject_beta_headers: adds "anthropic-beta: context-1m-2025-08-07"
```

**Implementasi:** Buat adapter registry sederhana di TypeScript:
- Detect client dari `User-Agent` header
- Per-client config: signature strategy, retry behavior, injected headers
- Start dengan adapter untuk: Zed, Claude Code, Continue, Cursor

---

### 3.8 🟡 Multi-Level Context Compression

> **Status: 🟡 sebagian.** Dua lapis (RTK, Headroom) jalan berurutan tiap request, bukan tiga tingkat yang dipicu rasio pemakaian konteks.

**Mengapa penting:** Antigravity-Manager tidak hanya punya soft/aggressive purification, tapi juga **3 threshold levels** yang triggered berdasarkan context usage ratio.

**Referensi kode:**

| File (REF:) | Ukuran | Fungsi |
|-------------|--------|--------|
| `config.rs` L260-303 | — | ExperimentalConfig with compression thresholds |

**Key config (config.rs):**
```
L260  pub struct ExperimentalConfig {
          pub enable_signature_cache: bool,              // Default: true
          pub enable_tool_loop_recovery: bool,           // Default: true
          pub enable_cross_model_checks: bool,           // Default: true
          pub enable_usage_scaling: bool,                // Default: false
L280      pub context_compression_threshold_l1: f32,     // Default: 0.4 (40%)
L284      pub context_compression_threshold_l2: f32,     // Default: 0.55 (55%)
L288      pub context_compression_threshold_l3: f32,     // Default: 0.70 (70%)
      }
```

**Compression levels:**
- **L1 (40% usage)**: Tool trimming — hapus old tool call/result pairs, keep last N rounds
- **L2 (55% usage)**: Thinking compression — strip thinking blocks, preserve signatures
- **L3 (70% usage)**: Fork + Summary — aggressive purification, summarize old context

**Implementasi:** Tambah ke context manager kita:
- Estimate context usage ratio sebelum kirim ke Google
- Apply compression level yang sesuai secara otomatis
- Log level yang diterapkan dan token yang dihemat

---

### 3.9 🟡 Global System Prompt Injection

> **Status: ✅ selesai dan lebih jauh.** Bisa di-override per provider, plus Caveman dengan 5 tingkat keringkasan.

**Mengapa penting:** Kadang kita ingin inject system instruction ke SEMUA request (misal: safety rules, response format, language preference) tanpa client perlu set-nya.

**Referensi kode:**

| File (REF:) | Ukuran | Fungsi |
|-------------|--------|--------|
| `config.rs` L60-95 | — | Global system prompt config |

**Key methods (config.rs):**
```
L64   static GLOBAL_SYSTEM_PROMPT_CONFIG: OnceLock<RwLock<GlobalSystemPromptConfig>>
L67   pub fn get_global_system_prompt() -> GlobalSystemPromptConfig
L76   pub fn update_global_system_prompt_config(config)
L126  pub struct GlobalSystemPromptConfig {
          pub enabled: bool,
          pub content: String,  // The system prompt text to inject
      }
```

**Implementasi:** Tambah env var atau config field `GLOBAL_SYSTEM_PROMPT`. Jika set, prepend ke `system_instruction` di Google API request.

---

### 3.10 🟡 Estimation Calibrator (Self-Learning Token Estimation)

> **Status: ✅ selesai (Agustus 2026).** `core/metrics/calibrator.ts`. Saat upstream
> melaporkan usage sungguhan, selisihnya terhadap estimasi kita direkam; faktornya
> dihaluskan, dijepit di [0.5, 3], dan baru dipakai setelah 20 sampel — estimasi awal
> yang percaya diri lebih buruk daripada tidak mengoreksi sama sekali. Persisted di
> `data/calibration.json` supaya bertahan lintas restart.

**Mengapa penting:** Token estimation kita static (character-based). Antigravity-Manager punya **self-learning calibrator** yang membandingkan estimated vs actual tokens dari Google API response, lalu auto-adjust factor-nya.

**Referensi kode:**

| File (REF:) | Ukuran | Fungsi |
|-------------|--------|--------|
| `mappers/estimation_calibrator.rs` | 5KB, 160 lines | Self-learning token estimator |

**Key struct & methods (estimation_calibrator.rs):**
```
L14   pub struct EstimationCalibrator {
          total_estimated: AtomicU64,
          total_actual: AtomicU64,
          sample_count: AtomicU64,
          calibration_factor: RwLock<f32>,    // Initial: 2.0
      }
L41   pub fn record(&self, estimated: u32, actual: u32)
      — Record estimated vs actual, auto-recalibrate every 5 samples
L59   fn update_calibration(&self)
      — new_factor = actual / estimated, clamped [0.8, 4.0]
      — EMA: 60% old + 40% new (stability + adaptability)
L89   pub fn apply(&self, raw_estimate: u32) -> u32
      — Apply calibration: raw_estimate * calibration_factor
```

**Implementasi:**
- Track `usageMetadata.promptTokenCount` dari Google API response
- Compare dengan estimated tokens dari `estimate_tokens_from_str()`
- Auto-adjust calibration factor menggunakan exponential moving average
- Gunakan calibrated estimate untuk menentukan compression level

---

### 3.11 🟡 Thinking Budget Config

> **Status: ✅ selesai.** Per-model `thinkingMode` (budget/level) dan `thinkingBudget` di model spec.

**Mengapa penting:** Saat ini kita hardcode thinking budget. Antigravity-Manager punya 4 mode yang configurable.

**Referensi kode:**

| File (REF:) | Ukuran | Fungsi |
|-------------|--------|--------|
| `config.rs` L320-358 | — | ThinkingBudgetConfig |

**Key structs (config.rs):**
```
L320  pub enum ThinkingBudgetMode {
          Auto,        // Cap at 24576 for Flash/Thinking models
          Passthrough, // Use client's value unchanged
          Custom,      // Use fixed custom_value
          Adaptive,    // Use effort parameter (low/medium/high)
      }
L339  pub struct ThinkingBudgetConfig {
          pub mode: ThinkingBudgetMode,
          pub custom_value: u32,        // Default: 24576
          pub effort: Option<String>,   // "low" | "medium" | "high"
      }
```

**Implementasi:** Tambah env var `THINKING_BUDGET_MODE` (auto/passthrough/custom/adaptive) dan `THINKING_BUDGET_VALUE`.

---

### 3.12 ✅ Model Specs from JSON Config

**Mengapa penting:** Per-model output token limits dan thinking budgets di-hardcode. Antigravity-Manager load dari JSON file, bisa di-override oleh account quota data.

**Referensi kode:**

| File (REF:) | Ukuran | Fungsi |
|-------------|--------|--------|
| `model_specs.rs` | 2.6KB, 87 lines | Model specs loader |

**Key methods (model_specs.rs):**
```
L7    pub struct ModelSpec {
          pub max_output_tokens: Option<u64>,
          pub thinking_budget: Option<u64>,
          pub is_thinking: Option<bool>,
      }
L25   pub fn resolve_alias(model_id) -> String
      — Resolve model aliases from specs JSON
L34   pub fn get_max_output_tokens(model_id, token) -> u64
      — Priority: 1) account dynamic data, 2) static JSON, 3) fallback 65535
L60   pub fn get_thinking_budget(model_id, token) -> u64
      — Priority: 1) static JSON config, 2) fallback 24576
L80   pub fn is_thinking_model(model_id) -> bool
      — Check from specs or model name contains "-thinking"
```

**Implementasi:** Buat `config/model-specs.json` yang loaded at startup. Per-model config untuk max_output_tokens, thinking_budget, is_thinking.

---

## 4. Prioritas rendah

Tiga sudah selesai (§4.1, §4.3, §4.9), dua sengaja ditolak (§4.4, §4.6), sisanya belum
dikerjakan dan sebagian besar memang tidak direkomendasikan — lihat [§7](#7-rekomendasi-berikutnya).

### 4.1 🟢 `/v1/models` Endpoint

> **Status: ✅ selesai dan lebih luas.** Melisting seluruh provider terdaftar, sudah ber-prefix, dalam format OpenAI maupun Anthropic.

Endpoint list model yang tersedia. Simple static response.

**REF:** `handlers/openai.rs` L2079 `handle_list_models()`

### 4.2 🟢 Imagen 3 Support

> **Status: ❌ belum ada.** Nougate adalah coding gateway; generasi gambar belum pernah diminta.

`/v1/images/generations` — transform OpenAI image request ke Gemini image model.

**REF:**
- `handlers/openai.rs` L2245 `handle_images_generations()`
- `handlers/openai.rs` L2268 `handle_images_generations_internal()`
- `mappers/common_utils.rs` L153 `parse_image_config()` — parse model suffix (e.g., `-16-9-4k`)
- `mappers/common_utils.rs` L172 `parse_image_config_with_params()` — parse size/quality params

### 4.3 🟢 API Key Auth Middleware (Multi-Token)

> **Status: ✅ selesai dan lebih ketat.** Gateway key `sk-nou-…`, disimpan sebagai hash SHA-256, **wajib** tanpa opsi mematikan, dengan usage per key yang bertahan sampai rollup 90 hari. Tanpa key sama sekali, gateway menolak semuanya.

Support multiple API keys dengan per-key usage tracking.

**REF:**
- `middleware/auth.rs` L15 `auth_middleware()` — proxy API auth
- `middleware/auth.rs` L24 `admin_auth_middleware()` — admin API auth (stricter)
- `middleware/auth.rs` L242 `pub struct UserTokenIdentity` — token identity struct

### 4.4 🟢 IP Whitelist/Blacklist

> **Status: ❌ sengaja tidak diadopsi.** Lihat [§6](#6-sengaja-tidak-diadopsi).

Security layer untuk membatasi akses berdasarkan IP.

**REF:** `middleware/ip_filter.rs` (7.6KB)

### 4.5 🟢 Account Warmup

> **Status: ❌ belum ada.** Token divalidasi pada penggunaan pertama, bukan saat startup.

Pre-flight validation: kirim request minimal ke Google saat startup untuk verify token masih valid.

**REF:**
- `handlers/warmup.rs` L44 `handle_warmup()` — POST /internal/warmup
- `server.rs` L684-685 — Per-account and bulk warmup routes

### 4.6 🟢 Outbound Proxy Pool

> **Status: ❌ sengaja tidak diadopsi.** Lihat [§6](#6-sengaja-tidak-diadopsi).

Rotasi HTTP proxy untuk outbound requests ke Google API (anti-fingerprinting).

**REF:** `proxy_pool.rs` (22KB, 620 lines) — HTTP proxy rotation manager

### 4.7 🟢 Tool Artifact Store

> **Status: ❌ belum ada.** RTK memangkas tool result di tempat; tidak ada sidecar store.

Sidecar store untuk large tool outputs. Daripada replay tool output besar (100KB+) di chat history, simpan di store dan berikan model hanya summary + artifact ID. Model bisa request full content via `read_tool_artifact`.

**REF:**
- `adapters/artifact_store.rs` L60 `pub struct ToolArtifactStore` (21KB, 569 lines)
- `adapters/artifact_store.rs` L109 `pub fn save(call_id, kind, raw_content) -> StoredToolArtifact`
- `adapters/artifact_store.rs` L152 `pub fn get(artifact_id) -> Option<ToolArtifactRecord>`
- `adapters/artifact_store.rs` L431 `pub fn global_tool_artifact_store()` — Global singleton

### 4.8 🟢 Error Classifier

> **Status: ✅ selesai (Agustus 2026).** `core/upstream-errors.ts` —
> `classifyUpstreamError()` provider-agnostic yang menjawab empat hal: layak diulang,
> layak ganti akun, apakah kegagalannya milik model atau seluruh akun, dan satu kalimat
> untuk operator. Kegagalan yang tidak dikenali jadi `unknown` dengan `retryable: false`,
> supaya mode gagal baru muncul sebagai error, bukan diulang selamanya.

Kategorisasi stream errors menjadi user-friendly types (timeout, connection, decode, stream, unknown) dengan i18n keys.

**REF:**
- `mappers/error_classifier.rs` L12 `pub fn classify_stream_error(error) -> (type, message, i18n_key)`
- Returns: `"timeout_error"`, `"connection_error"`, `"decode_error"`, `"stream_error"`, `"unknown_error"`

### 4.9 🔴 Debug Payload Logger

> **Status: ❌ dihapus, belum diadopsi.** Sempat ada modul `core/debug-logger.ts`
> lengkap dengan blok config di `config.json`, tapi ternyata **tidak pernah
> dipanggil dari mana pun** — nol call site. Jadi fiturnya tidak pernah benar-benar
> ada; yang ada cuma config yang tidak menggerakkan apa-apa. Modul dan config-nya
> dihapus daripada dibiarkan terlihat seperti fitur yang jalan.
>
> Kalau nanti diadopsi ulang: panggil dari kedua protocol handler
> (`protocols/openai/handler.ts`, `protocols/anthropic/handler.ts`), taruh
> output-nya di bawah `data/` lewat `dataPath()`, dan biarkan toggle-nya di kode
> saja — nulis payload utuh ke disk itu keputusan waktu debugging, bukan switch
> yang enak ditinggal di form dashboard.

Dump full request/response JSON ke disk untuk debugging. Configurable output directory dan toggle.

**REF:**
- `debug_logger.rs` L24 `pub async fn write_debug_payload(cfg, trace_id, prefix, payload)`
- `config.rs` L374 `pub struct DebugLoggingConfig { enabled, output_dir }`

### 4.10 🟢 Quota Scheduler

> **Status: ❌ belum ada.** Kuota Antigravity di-poll berkala, tapi tidak ada scan yang memicu warmup.

Background task yang scan semua akun setiap 10 menit, detect model yang sudah 100% quota, dan trigger warmup untuk pre-refresh tokens.

**REF:**
- `modules/scheduler.rs` L53 `pub fn start_scheduler()` — Scan every 600s
- `modules/scheduler.rs` L309 `pub async fn trigger_warmup_for_account(account)`
- `modules/quota.rs` L654 `pub async fn warm_up_all_accounts()`

### 4.11 🟢 HTTP Session Store (Codex)

> **Status: ❌ belum ada.** Bergantung pada `/v1/responses` yang juga belum ada.

In-memory session store untuk `/v1/responses` POST mode. Enables multi-turn via `previous_response_id` chain tanpa WebSocket.

**REF:**
- `http_session_store.rs` L14 `pub struct HttpSessionEntry { input_items, instructions, model }`
- `http_session_store.rs` L62 `pub async fn get_session(previous_response_id) -> Option<HttpSessionEntry>`
- `http_session_store.rs` L67 `pub async fn save_session(response_id, entry)`
- TTL: 1 hour, lazy eviction

---

## 5. Arsitektur

Diagram target yang dulu ada di sini sudah terlampaui — bentuk sekarang, termasuk
lapisan multi-provider yang tidak ada dalam rencana awal, didokumentasikan di
[ARCHITECTURE.md](ARCHITECTURE.md).

---

## 6. Sengaja tidak diadopsi

Bukan backlog. Ini keputusan, dengan alasannya.

| Fitur | Alasan |
|---|---|
| **IP whitelist/blacklist** | Nougate berjalan di belakang reverse proxy. Filter IP adalah pekerjaan lapisan itu, dan menaruhnya di aplikasi berarti dua tempat yang bisa tidak sinkron. Gateway API key sudah menjawab "siapa yang boleh memakai". |
| **Outbound proxy pool** | Rotasi IP keluar untuk menghindari fingerprinting upstream. Tidak sejalan dengan cara kita dipakai, dan menambah komponen jaringan yang harus dijaga. |
| **Tauri / desktop app** | Nougate adalah layanan yang dipakai bersama, bukan aplikasi satu mesin. |
| **IDE account switching** | Fitur desktop Manager; tidak berlaku untuk gateway. |
| **In-memory-only storage** | Prinsip lama "no SQLite, no external deps" **sudah dibatalkan**. Metrics, user, API key, dan custom provider butuh query dan agregasi — file JSON tidak bisa. Yang tersisa di JSON hanya akun dan config provider, supaya tetap bisa dibaca dan diedit tangan. |

---

## 7. Rekomendasi berikutnya

Diurutkan berdasarkan dampak nyata, bukan urutan aslinya.

~~**1. Rate limit per model**~~ · ~~**2. Estimation calibrator**~~ · ~~**Error
classifier**~~ — selesai Agustus 2026.

~~**Pemilihan akun sadar sisa kuota**~~ — selesai Agustus 2026.

**1. Cross-provider fallback** — bukan dari daftar Manager, tapi gap terbesar Nougate
secara keseluruhan. Bahannya sudah ada: registry provider, `getBestAccount` yang
mengembalikan `null` saat habis, dan `UpstreamErrorClass.rotate` yang sudah tahu kapan
pantas pindah.

**2. Multi-level context compression** ([§3.8](#38--multi-level-context-compression)) —
sekarang layak dikerjakan, karena kalibrator sudah memberi estimasi token yang bisa
dipercaya untuk memilih level.

**3. Client adapter system** ([§3.7](#37--client-adapter-system)) — mulai dari satu
kebutuhan nyata (misalnya strategi buffer signature untuk satu klien yang bermasalah),
jangan bangun registry-nya dulu.

**4. Codex `/v1/responses`** ([§3.5](#35--codex--responses-endpoint)) — kerjakan hanya
kalau memang ada yang mau memakai Codex CLI lewat gateway ini.

Yang **tidak** saya rekomendasikan dikejar: Imagen, Gemini native endpoint, artifact
store, quota scheduler, account warmup. Semuanya masuk akal untuk produk Manager, tapi
tidak menjawab kebutuhan Nougate hari ini.

---

## 8. Prinsip desain

1. **Jangan pernah bercabang berdasarkan nama provider.** Perbedaan perilaku dinyatakan
   sebagai *capability* di kontrak `IProvider`, dan pemanggil memeriksa keberadaan
   method-nya. Ini yang membuat provider baru tidak menyentuh core.
2. **Tanpa jalur legacy dan tanpa rantai fallback.** Breaking change diterima; shim
   kompatibilitas yang diam-diam tidak.
3. **Semua state di bawah `data/`,** diselesaikan lewat `core/paths.ts`.
4. **Jangan mengarang angka.** Model tanpa harga dilaporkan *unpriced*, bukan diberi tarif
   yang masuk akal. Akun yang belum terverifikasi tidak menyumbang nol ke rata-rata kuota.
5. **Backward compatible di jalur data, tidak di config.** Klien tidak boleh rusak diam-diam;
   setelan yang usang dihapus, tidak dipertahankan selamanya.
6. **Setiap fitur punya test, dan test-nya dibuktikan menangkap bug** dengan cara merusak
   perbaikannya lebih dulu.

Panduan lengkap untuk mengerjakan kode ini ada di `.claude/skills/nougate-contributing/`.
