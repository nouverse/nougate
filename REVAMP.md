# Antigravity Proxy — Revamp Plan

Dokumen ini merangkum fitur-fitur inti dari [Antigravity-Manager](https://github.com/lbjlaq/Antigravity-Manager) (Rust/Axum, 30k★) yang relevan dan layak diadopsi ke proxy kita (Bun/TypeScript), beserta prioritas dan estimasi kompleksitas.

> [!NOTE]
> Semua fitur di bawah dipilih berdasarkan **analisis langsung** terhadap source code `src-tauri/src/proxy/` dari Antigravity-Manager v4.3.0. Source code referensi tersedia di `tmp/antigravity-manager/`. Fitur yang hanya relevan untuk desktop app (Tauri GUI, IDE account switching, dll.) **tidak** dimasukkan.

> [!TIP]
> Prefix path `REF:` di bawah merujuk ke `tmp/antigravity-manager/src-tauri/src/proxy/` relatif dari root project kita.

---

## 1. Gap Analysis: Kita vs Antigravity-Manager

| Fitur | Proxy Kita | Antigravity-Manager | Implemented | Priority | Section |
|-------|:----------:|:-------------------:|:-----------:|:--------:|:-------:|
| OpenAI-compatible endpoint | ✅ | ✅ | ✅ | — | — |
| Anthropic native `/v1/messages` | ✅ | ✅ | ✅ | 🔴 High | [§2.1](#21--native-anthropic-endpoint-v1messages) |
| Multi-layer signature cache | 🟡 Basic (2-layer) | ✅ (4-layer: tool, family, session, reasoning) | 🟡 Basic | 🔴 High | [§2.2](#22--multi-layer-signature-cache) |
| Tiered account sorting (Ultra/Pro/Free) | ❌ | ✅ | ❌ | 🔴 High | [§2.3](#23--tiered-account-sorting) |
| Model-level rate limiting | 🟡 Basic (family-level) | ✅ (account + model level) | 🟡 Basic | 🔴 High | [§2.4](#24--model-level-rate-limiting) |
| Rate limit tracker with exponential backoff | ✅ (with backoff) | ✅ (per-account failure counter + backoff) | ✅ | 🔴 High | [§2.4](#24--model-level-rate-limiting) |
| **JSON Schema cleaning for Gemini** | ✅ | ✅ ($ref flatten, anyOf, constraint→desc) | ✅ | 🔴 **High** | [§2.5](#25--json-schema-cleaning-for-gemini) |
| **Smart retry delay parsing + grace retry** | ❌ | ✅ (recursive JSON parse + 1.5s grace window) | ❌ | 🔴 **High** | [§2.6](#26--smart-retry-delay-parsing--grace-retry) |
| Model routing / wildcard mapping | ❌ (hardcoded) | ✅ (exact + wildcard + specificity scoring) | ❌ | 🟡 Medium | [§3.1](#31--dynamic-model-routing) |
| Tool result compression | ❌ | ✅ (browser snapshot, HTML cleanup) | ❌ | 🟡 Medium | [§3.2](#32--tool-result-compression) |
| Context purification (thinking strip) | 🟡 Basic (strips previous thinking) | ✅ (soft/aggressive + token estimation) | 🟡 Basic | 🟡 Medium | [§3.3](#33--context-purification) |
| Request monitoring / usage logging | ❌ | ✅ (SQLite + real-time stats) | ❌ | 🟡 Medium | [§3.4](#34--request-monitoring--usage-stats) |
| Codex `/v1/responses` endpoint | ❌ | ✅ | ❌ | 🟡 Medium | [§3.5](#35--codex--responses-endpoint) |
| **Session fingerprinting** | ✅ | ✅ (SHA256 of first user message) | ✅ | 🟡 **Medium** | [§3.6](#36--session-fingerprinting) |
| **Client adapter system** | ❌ | ✅ (per-IDE behavior via User-Agent) | ❌ | 🟡 **Medium** | [§3.7](#37--client-adapter-system) |
| **Multi-level context compression** | ❌ | ✅ (L1: tool trim, L2: thinking, L3: fork) | ❌ | 🟡 **Medium** | [§3.8](#38--multi-level-context-compression) |
| **Global system prompt injection** | ❌ | ✅ (auto-inject to all requests) | ❌ | 🟡 **Medium** | [§3.9](#39--global-system-prompt-injection) |
| **Estimation calibrator** | ❌ | ✅ (self-learning token estimation) | ❌ | 🟡 **Medium** | [§3.10](#310--estimation-calibrator-self-learning-token-estimation) |
| **Thinking budget config** | ❌ | ✅ (Auto/Passthrough/Custom/Adaptive modes) | ❌ | 🟡 **Medium** | [§3.11](#311--thinking-budget-config) |
| **Model specs from JSON** | ❌ | ✅ (per-model max_output_tokens, thinking_budget) | ✅ | 🟡 **Medium** | [§3.12](#312--model-specs-from-json-config) |
| Background task silent downgrade | ❌ | ✅ (reroute ke Flash) | ❌ | 🟡 Medium | [§3.1](#31--dynamic-model-routing) |
| Gemini native endpoint | ❌ | ✅ | ❌ | 🟡 Medium | — |
| `/v1/models` endpoint | ✅ | ✅ | ✅ | 🟢 Low | [§4.1](#41--v1models-endpoint) |
| `/v1/images/generations` (Imagen 3) | ❌ | ✅ | ❌ | 🟢 Low | [§4.2](#42--imagen-3-support) |
| API Key auth middleware (multi-token) | ❌ (single header) | ✅ (per-user tokens + whitelist/blacklist) | ❌ | 🟢 Low | [§4.3](#43--api-key-auth-middleware-multi-token) |
| IP filtering / security | ❌ | ✅ (whitelist/blacklist + access logs) | ❌ | 🟢 Low | [§4.4](#44--ip-whitelistblacklist) |
| Account warmup | ❌ | ✅ (pre-flight token validation) | ❌ | 🟢 Low | [§4.5](#45--account-warmup) |
| Proxy pool (outbound HTTP proxy rotation) | ❌ | ✅ | ❌ | 🟢 Low | [§4.6](#46--outbound-proxy-pool) |
| **Tool artifact store** | ❌ | ✅ (sidecar store for large tool outputs) | ❌ | 🟢 **Low** | [§4.7](#47--tool-artifact-store) |
| **Error classifier** | ❌ | ✅ (categorize stream errors with i18n) | ❌ | 🟢 **Low** | [§4.8](#48--error-classifier) |
| **Debug payload logger** | ❌ | ✅ (dump req/res JSON to disk) | ❌ | 🟢 **Low** | [§4.9](#49--debug-payload-logger) |
| **Quota scheduler** | ❌ | ✅ (auto-scan 100% quota, trigger warmup) | ❌ | 🟢 **Low** | [§4.10](#410--quota-scheduler) |
| HTTP Session Store (Codex) | ❌ | ✅ (multi-turn via previous_response_id) | ❌ | 🟢 Low | [§4.11](#411--http-session-store-codex) |
| OAuth browser flow | ✅ | ✅ (callback handler) | ✅ | 🟢 Low | — |

---

## 2. Fitur yang Akan Diadopsi (Prioritas Tinggi)

### 2.1 🔴 Native Anthropic Endpoint (`/v1/messages`)

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

## 3. Fitur yang Akan Diadopsi (Prioritas Medium)

### 3.1 🟡 Dynamic Model Routing

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

**Implementasi (lightweight, tanpa SQLite):**
- In-memory circular buffer (max 1000 entries)
- `GET /api/stats/summary` → total requests, success rate, avg latency
- `GET /api/stats/models` → breakdown per model
- `GET /api/stats/accounts` → breakdown per account
- Persist ke file setiap 5 menit (opsional)

---

### 3.5 🟡 Codex / Responses Endpoint

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

## 4. Fitur Prioritas Rendah (Nice-to-Have)

### 4.1 🟢 `/v1/models` Endpoint

Endpoint list model yang tersedia. Simple static response.

**REF:** `handlers/openai.rs` L2079 `handle_list_models()`

### 4.2 🟢 Imagen 3 Support

`/v1/images/generations` — transform OpenAI image request ke Gemini image model.

**REF:**
- `handlers/openai.rs` L2245 `handle_images_generations()`
- `handlers/openai.rs` L2268 `handle_images_generations_internal()`
- `mappers/common_utils.rs` L153 `parse_image_config()` — parse model suffix (e.g., `-16-9-4k`)
- `mappers/common_utils.rs` L172 `parse_image_config_with_params()` — parse size/quality params

### 4.3 🟢 API Key Auth Middleware (Multi-Token)

Support multiple API keys dengan per-key usage tracking.

**REF:**
- `middleware/auth.rs` L15 `auth_middleware()` — proxy API auth
- `middleware/auth.rs` L24 `admin_auth_middleware()` — admin API auth (stricter)
- `middleware/auth.rs` L242 `pub struct UserTokenIdentity` — token identity struct

### 4.4 🟢 IP Whitelist/Blacklist

Security layer untuk membatasi akses berdasarkan IP.

**REF:** `middleware/ip_filter.rs` (7.6KB)

### 4.5 🟢 Account Warmup

Pre-flight validation: kirim request minimal ke Google saat startup untuk verify token masih valid.

**REF:**
- `handlers/warmup.rs` L44 `handle_warmup()` — POST /internal/warmup
- `server.rs` L684-685 — Per-account and bulk warmup routes

### 4.6 🟢 Outbound Proxy Pool

Rotasi HTTP proxy untuk outbound requests ke Google API (anti-fingerprinting).

**REF:** `proxy_pool.rs` (22KB, 620 lines) — HTTP proxy rotation manager

### 4.7 🟢 Tool Artifact Store

Sidecar store untuk large tool outputs. Daripada replay tool output besar (100KB+) di chat history, simpan di store dan berikan model hanya summary + artifact ID. Model bisa request full content via `read_tool_artifact`.

**REF:**
- `adapters/artifact_store.rs` L60 `pub struct ToolArtifactStore` (21KB, 569 lines)
- `adapters/artifact_store.rs` L109 `pub fn save(call_id, kind, raw_content) -> StoredToolArtifact`
- `adapters/artifact_store.rs` L152 `pub fn get(artifact_id) -> Option<ToolArtifactRecord>`
- `adapters/artifact_store.rs` L431 `pub fn global_tool_artifact_store()` — Global singleton

### 4.8 🟢 Error Classifier

Kategorisasi stream errors menjadi user-friendly types (timeout, connection, decode, stream, unknown) dengan i18n keys.

**REF:**
- `mappers/error_classifier.rs` L12 `pub fn classify_stream_error(error) -> (type, message, i18n_key)`
- Returns: `"timeout_error"`, `"connection_error"`, `"decode_error"`, `"stream_error"`, `"unknown_error"`

### 4.9 🟢 Debug Payload Logger

Dump full request/response JSON ke disk untuk debugging. Configurable output directory dan toggle.

**REF:**
- `debug_logger.rs` L24 `pub async fn write_debug_payload(cfg, trace_id, prefix, payload)`
- `config.rs` L374 `pub struct DebugLoggingConfig { enabled, output_dir }`

### 4.10 🟢 Quota Scheduler

Background task yang scan semua akun setiap 10 menit, detect model yang sudah 100% quota, dan trigger warmup untuk pre-refresh tokens.

**REF:**
- `modules/scheduler.rs` L53 `pub fn start_scheduler()` — Scan every 600s
- `modules/scheduler.rs` L309 `pub async fn trigger_warmup_for_account(account)`
- `modules/quota.rs` L654 `pub async fn warm_up_all_accounts()`

### 4.11 🟢 HTTP Session Store (Codex)

In-memory session store untuk `/v1/responses` POST mode. Enables multi-turn via `previous_response_id` chain tanpa WebSocket.

**REF:**
- `http_session_store.rs` L14 `pub struct HttpSessionEntry { input_items, instructions, model }`
- `http_session_store.rs` L62 `pub async fn get_session(previous_response_id) -> Option<HttpSessionEntry>`
- `http_session_store.rs` L67 `pub async fn save_session(response_id, entry)`
- TTL: 1 hour, lazy eviction

---

## 5. Arsitektur Target

```mermaid
graph TD
    Client[Client / IDE / Claude Code] -->|Request| Gateway[Bun.serve Gateway]
    
    Gateway --> AuthMW[Auth Middleware]
    AuthMW --> ProtocolDetect{Protocol Detection}
    
    ProtocolDetect -->|/v1/chat/completions| OpenAIHandler[OpenAI Handler]
    ProtocolDetect -->|/v1/messages| AnthropicHandler[Anthropic Handler]
    ProtocolDetect -->|/v1/responses| CodexHandler[Codex Handler]
    ProtocolDetect -->|/v1beta/models| GeminiHandler[Gemini Handler]
    
    OpenAIHandler --> ModelRouter[Model Router]
    AnthropicHandler --> ModelRouter
    CodexHandler --> ModelRouter
    GeminiHandler --> ModelRouter
    
    ModelRouter --> ContextManager[Context Manager]
    ContextManager -->|Purify + Compress| RequestMapper[Request Mapper to Google]
    
    RequestMapper --> AccountSelector[Account Selector]
    AccountSelector -->|Tiered Sort + Health + Quota| AccountPool[(Account Pool)]
    
    AccountSelector --> SignatureCache[4-Layer Signature Cache]
    SignatureCache --> GoogleAPI[Google Gemini API]
    
    GoogleAPI --> RateLimitTracker[Rate Limit Tracker]
    RateLimitTracker -->|429/403| AccountSelector
    
    GoogleAPI --> ResponseMapper[Response Mapper]
    ResponseMapper --> Monitor[Request Monitor]
    ResponseMapper --> Client
    
    Monitor --> StatsAPI[GET /api/stats/*]
```

---

## 7. Roadmap Implementasi

### Phase 1: Core Robustness (1-2 minggu)
Perkuat fondasi yang sudah ada tanpa mengubah API surface.

- [x] **JSON Schema Cleaning** — Strip `$ref`, `anyOf`, `additionalProperties`, constraint→description
- [ ] **4-Layer Signature Cache** — Upgrade `cache.ts` dengan session tracking + rewind detection
- [ ] **Smart Retry Delay Parsing** — Deep parse 429 errors + grace retry ≤2s
- [ ] **Tiered Account Sorting** — Upgrade `manager.ts` dengan multi-dimension sorting
- [ ] **Model-Level Rate Limiting** — Upgrade rate limit dari account-level ke account:model level
- [x] **Rate Limit Exponential Backoff** — Per-account failure counter + grace window
- [ ] **Tool Result Compression** — Tambah compression layer di `transform.ts`
- [ ] **Context Purification Enhancement** — Token estimation + auto aggressive mode
- [x] **Session Fingerprinting** — SHA256 first user message → stable session ID

### Phase 2: Multi-Protocol (2-3 minggu)
Tambah endpoint baru untuk mendukung lebih banyak client.

- [x] **Refactor ke handler-based architecture** — Pisah `server.ts` ke `handlers/*`
- [x] **Anthropic `/v1/messages`** — Full Claude Code CLI support
- [ ] **Codex `/v1/responses`** — OpenAI Codex CLI support
- [x] **`GET /v1/models`** — Model listing endpoint
- [ ] **Dynamic Model Router** — Configurable routing via JSON + wildcard
- [x] **Model Specs from JSON** — Per-model max_output_tokens, thinking_budget

### Phase 3: Intelligence (1-2 minggu)
Fitur-fitur cerdas yang meningkatkan kualitas proxying.

- [ ] **Multi-Level Context Compression** — L1 (40%), L2 (55%), L3 (70%) thresholds
- [ ] **Estimation Calibrator** — Self-learning token estimation dari actual usage
- [ ] **Client Adapter System** — Per-IDE behavior (Zed, Claude Code, Continue)
- [ ] **Thinking Budget Config** — Auto/Passthrough/Custom/Adaptive modes
- [ ] **Global System Prompt Injection** — Auto-inject system instruction to all requests

### Phase 4: Observability (1 minggu)
- [ ] **Request Monitor** — In-memory request logging
- [ ] **Stats API** — `/api/stats/summary`, `/api/stats/models`, `/api/stats/accounts`
- [ ] **Error Classifier** — Categorize errors into user-friendly types
- [ ] **Debug Payload Logger** — Optional JSON dump to disk
- [ ] **Structured Logging** — Consistent log format dengan request ID tracking

### Phase 5: Security & Polish (1 minggu)
- [ ] **Multi-Token Auth** — Support multiple API keys
- [ ] **IP Filtering** — Whitelist/blacklist
- [ ] **Account Warmup** — Pre-flight validation on startup
- [ ] **Quota Scheduler** — Background scan for 100% quota, auto-warmup
- [ ] **Imagen 3 Support** — `/v1/images/generations`

---

## 8. Prinsip Desain

1. **Tetap Lightweight** — Jangan adopt arsitektur desktop app Manager (Tauri, SQLite) ke server proxy kita. Gunakan in-memory + file persistence.
2. **Backward Compatible** — Setiap phase harus tetap backward compatible. `/v1/chat/completions` tidak boleh break.
3. **Incremental** — Setiap item dalam roadmap bisa di-deploy independen.
4. **Test-Driven** — Setiap fitur baru harus punya unit test sebelum merge.
5. **Single Binary** — Tetap bisa di-deploy sebagai single Docker container tanpa external dependencies (no SQLite, no Redis).
