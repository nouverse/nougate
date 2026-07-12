# Modular Implementation Plan — Antigravity Proxy

> **Dokumen ini adalah panduan lengkap untuk refactor `nougate` menjadi arsitektur modular.**
> Setiap Phase dirancang untuk dikerjakan dalam satu sesi agent terpisah.
> **Jangan ubah kode sebelum membaca seluruh dokumen ini.**

---

## ⚠️ Breaking Changes

> [!CAUTION]
> Refactor ini **sengaja memutus backward compatibility**. Tidak ada legacy alias. Semua client harus update konfigurasi mereka.

| Yang Berubah | Sebelum | Sesudah |
|---|---|---|
| Endpoint chat | `POST /v1/chat/completions` | `POST /openai/v1/chat/completions` |
| Endpoint models | `GET /v1/models` | `GET /openai/v1/models` |
| Endpoint Anthropic | tidak ada | `POST /anthropic/v1/messages` |
| Format model ID | `gemini-3.5-flash-low` | `antigravity:gemini-3.5-flash-low` |
| Import path auth | `src/auth/*` | `src/providers/antigravity/auth/*` |
| Import path headers | `src/utils/headers.ts` | `src/providers/antigravity/upstream/headers.ts` |
| Import path errors | `src/utils/errors.ts` | `src/providers/antigravity/upstream/errors.ts` |
| Import path quota | `src/api/quota.ts` | `src/providers/antigravity/api/quota.ts` |
| Import transform | `src/utils/transform.ts` | `src/protocols/openai/mapper-in.ts` + `mapper-out.ts` |

**Update yang perlu dilakukan di client/IDE setelah refactor:**
- Set `base_url` ke `http://localhost:3000/openai` (bukan `/`)
- Gunakan model format `antigravity:gemini-3.5-flash-low` (bukan `gemini-3.5-flash-low`)
- Untuk Claude Code CLI: set `ANTHROPIC_BASE_URL=http://localhost:3000/anthropic`

**File yang dihapus total:**
- `src/auth/` (seluruh direktori)
- `src/api/` (seluruh direktori)
- `src/utils/transform.ts`
- `src/utils/headers.ts`
- `src/utils/errors.ts`

---

## Konteks & Filosofi

### Masalah Saat Ini

| File | Baris | Masalah |
|------|-------|---------|
| `src/server.ts` | 767 | Monolitik: routing + business logic + retry + stream handling semua di satu file |
| `src/auth/` | — | Hard-coupled ke Google OAuth, tidak ada abstraction |
| `src/utils/transform.ts` | 748 | Hanya OpenAI→Google, tidak extensible |
| Model ID | — | Tidak ada provider prefix, `gemini-3.5-flash-low` ambigu dari provider mana |

### Tujuan Refactor

1. **Provider & Protocol terpisah** — provider adalah *sumber auth/akun* (antigravity, codex, cursor), protocol adalah *format API* (openai, anthropic). Keduanya orthogonal.
2. **Multi-auth** — bisa tambah Codex, Cursor, dll tanpa ubah core
3. **Multi-protocol endpoint** — `/openai/v1/chat/completions`, `/anthropic/v1/messages`, dll
4. **Provider-prefixed model** — `antigravity:gemini-3.5-flash`, bisa juga `antigravity:claude-sonnet-4-6` (provider antigravity, model claude)
5. **Zero regression** — backward compatible, `/v1/chat/completions` tetap jalan

### Konsep Kunci: Provider vs Protocol

```
Provider = siapa yang menyediakan akun/credential
  → antigravity  (Google OAuth + Cloud Code API)
  → codex        (future: OpenAI key)
  → cursor       (future: Cursor API key)

Protocol = format API yang diterima client
  → openai       (format: { model, messages, ... })
  → anthropic    (format: { model, messages, system, ... })

Model = provider:model-id
  → antigravity:gemini-3.5-flash-low
  → antigravity:claude-sonnet-4-6    ← provider antigravity, tapi model claude!
  → antigravity:gemini-3-pro-high

Contoh request:
  POST /anthropic/v1/messages
  { "model": "antigravity:claude-sonnet-4-6", ... }

  = Protocol anthropic + Provider antigravity + Model claude-sonnet-4-6

  POST /openai/v1/chat/completions
  { "model": "antigravity:gemini-3.5-flash-low", ... }

  = Protocol openai + Provider antigravity + Model gemini-3.5-flash-low
```

---

## Struktur File Target (Final)

> **Note**: `src/` paths di checklist items = relatif ke `apps/backend/`.

```
nougate/
├── apps/
│   ├── backend/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── config.json                      # GLOBAL proxy config
│   │   ├── providers/                       # Runtime per-provider config & state
│   │   │   └── antigravity/
│   │   │       ├── config.json
│   │   │       └── accounts.json
│   │   ├── src/
│   ├── server.ts                        # Entry point: init + Bun.serve (< 80 baris)
│   │
│   ├── router/
│   │   ├── index.ts                     # Central router: dispatch ke handler
│   │   ├── admin.ts                     # Admin routes: /api/*, /oauth-callback, /frontend/*
│   │   └── middleware.ts                # CORS + request logging + log capture
│   │
│   ├── core/
│   │   ├── interfaces.ts                # IProvider, IProtocolHandler, IAccount (semua interface)
│   │   ├── registry.ts                  # Global provider & handler registry
│   │   ├── model-resolver.ts            # Parse "antigravity:gemini-3.5-flash" → { provider, modelId }
│   │   └── request-context.ts           # RequestContext type: parsed request info
│   │
│   ├── providers/
│   │   └── antigravity/
│   │       ├── index.ts                 # AntigravityProvider class + registerAntigravityProvider()
│   │       ├── config/
│   │       │   ├── model-specs.ts       # [MOVE + DELETE ORIGINAL] dari src/config/model-specs.ts
│   │       │   └── model-specs.json     # [MOVE + DELETE ORIGINAL] dari config/model-specs.json
│   │       ├── auth/
│   │       │   ├── manager.ts           # [MOVE + DELETE ORIGINAL] dari src/auth/manager.ts
│   │       │   ├── oauth.ts             # [MOVE + DELETE ORIGINAL] dari src/auth/oauth.ts
│   │       │   ├── storage.ts           # [MOVE + DELETE ORIGINAL] dari src/auth/storage.ts
│   │       │   └── types.ts             # [MOVE + DELETE ORIGINAL] dari src/auth/types.ts
│   │       ├── api/
│   │       │   └── quota.ts             # [MOVE + DELETE ORIGINAL] dari src/api/quota.ts
│   │       └── upstream/
│   │           ├── executor.ts          # [NEW] retry loop + fetch logic (extract dari server.ts)
│   │           ├── headers.ts           # [MOVE + DELETE ORIGINAL] dari src/utils/headers.ts
│   │           └── errors.ts            # [MOVE + DELETE ORIGINAL] dari src/utils/errors.ts
│   │
│   ├── protocols/
│   │   ├── openai/
│   │   │   ├── index.ts                 # Register handler (side-effect import)
│   │   │   ├── handler.ts               # [EXTRACT + DELETE dari server.ts]
│   │   │   ├── mapper-in.ts             # [EXTRACT + DELETE dari src/utils/transform.ts]
│   │   │   └── mapper-out.ts            # [EXTRACT + DELETE dari src/utils/transform.ts]
│   │   └── anthropic/
│   │       ├── index.ts                 # Register handler
│   │       ├── handler.ts               # [NEW Phase 2]
│   │       ├── mapper-in.ts             # [NEW Phase 2]
│   │       └── mapper-out.ts            # [NEW Phase 2]
│   │
│   ├── config/
│   │   ├── manager.ts                   # [KEEP] — proxy-level config (rotation, retry, dll)
│   │   └── types.ts                     # [KEEP] — ProxyConfig types
│   │   # model-specs.ts DIHAPUS → pindah ke providers/antigravity/config/
│   │
│   ├── utils/
│   │   ├── cache.ts                     # [KEEP]
│   │   └── schema.ts                    # [KEEP]
│   │
│   └── frontend/                        # [KEEP]
│
├── antigravity-accounts.json            # [KEEP]
└── config.json                          # [KEEP]

# File yang DIHAPUS TOTAL (breaking):
# src/auth/                  ← pindah ke providers/antigravity/auth/
# src/api/                   ← pindah ke providers/antigravity/api/
# src/config/model-specs.ts  ← pindah ke providers/antigravity/config/model-specs.ts
# config/model-specs.json    ← pindah ke providers/antigravity/config/model-specs.json
# src/utils/transform.ts     ← dipecah ke protocols/openai/mapper-{in,out}.ts
# src/utils/headers.ts       ← pindah ke providers/antigravity/upstream/headers.ts
# src/utils/errors.ts        ← pindah ke providers/antigravity/upstream/errors.ts
```

---

## Model Spec: Per-Provider, No Global, No Fallback

> [!IMPORTANT]
> Ini adalah perubahan desain kunci. Model spec **bukan** global — setiap provider define spec model-nya sendiri.
> `antigravity:claude-sonnet-4-6` dan `cursor:claude-sonnet-4-6` adalah model yang **berbeda dan terpisah**. Tidak ada tabrakan, tidak ada shared registry.

### Konsep

```
REQUEST: model = "antigravity:claude-sonnet-4-6"
  → resolveModel()  → { providerId: "antigravity", modelId: "claude-sonnet-4-6" }
  → getProvider("antigravity")
  → provider.getModelSpec("claude-sonnet-4-6")  ← lookup HANYA di registry antigravity
  → null? → 400 Model not found in provider
  → IModelSpec { pool: "sandbox", isThinking: true, ... }

REQUEST: model = "cursor:claude-sonnet-4-6"
  → resolveModel()  → { providerId: "cursor", modelId: "claude-sonnet-4-6" }
  → getProvider("cursor")
  → provider.getModelSpec("claude-sonnet-4-6")  ← lookup HANYA di registry cursor
  → IModelSpec { ... }  ← completely independent spec
```

**Tidak ada cross-provider lookup, tidak ada fallback ke model lain, tidak ada `gptFallbacks`.**

### `IModelSpec` — Interface Per Model

```typescript
// Di src/core/interfaces.ts

export interface IModelSpec {
  /** Model ID dalam registry provider ini (TANPA prefix) */
  modelId: string;

  /** Display name (opsional, untuk /v1/models listing) */
  displayName?: string;

  /**
   * Pool yang dipakai untuk model ini.
   * antigravity: 'cli' = Gemini CLI endpoint, 'sandbox' = Cloud Code sandbox endpoint
   * Provider lain bisa ignore field ini.
   */
  pool: 'cli' | 'sandbox';

  /** Apakah model ini punya kemampuan thinking/reasoning */
  isThinking: boolean;

  /** Default thinking budget tokens (jika isThinking: true) */
  thinkingBudget?: number;

  /**
   * Mode thinking config: 'budget' = thinkingBudget, 'level' = thinkingLevel
   * (antigravity-specific: Gemini 3-pro pakai 'level', Gemini 2.5-flash pakai 'budget')
   */
  thinkingMode?: 'budget' | 'level';

  /** Default thinking level jika thinkingMode = 'level' */
  thinkingLevel?: 'low' | 'medium' | 'high';

  /** Max output tokens */
  maxOutputTokens: number;

  /**
   * Exact Google API model ID yang dikirim ke upstream.
   * Kalau tidak set, pakai modelId as-is.
   * 
   * Contoh: modelId = "claude-sonnet-4-6" → upstreamModelId = "claude-sonnet-4-6-thinking"
   * (ini menggantikan forceThinkingAliases)
   */
  upstreamModelId?: string;

  /**
   * Apakah model ini menggunakan Gemini CLI endpoint atau Sandbox endpoint.
   * antigravity-specific. Provider lain bisa punya logika berbeda.
   */
  useCliPool?: boolean;  // override dari pool field, lebih explicit
}

/** Registry model untuk satu provider */
export interface IModelRegistry {
  /**
   * Lookup model spec berdasarkan modelId (TANPA provider prefix).
   * Return null jika tidak ditemukan (handler akan return 400).
   * TIDAK ADA FALLBACK.
   */
  getSpec(modelId: string): IModelSpec | null;

  /** Semua model ID yang ada di registry ini */
  listModelIds(): string[];
}
```

### Update `IProvider` — Tambah `getModelRegistry()`

```typescript
// Di src/core/interfaces.ts — update IProvider
export interface IProvider {
  readonly id: string;
  readonly displayName: string;

  init(): Promise<void>;
  getBestAccount(options: AccountRequestOptions): Promise<IAccount | null>;
  updateAccountUsage(accountId: string, success: boolean, meta: { modelId?: string; pool?: string; clientId?: string; statusCode?: number }): Promise<void>;
  getAccounts(): IAccount[];

  /** Model registry khusus provider ini — tidak ada global registry */
  getModelRegistry(): IModelRegistry;
}
```

### Handler Flow (Enforced Strict)

```typescript
// Di setiap protocol handler (openai, anthropic)
async handle(ctx: RequestContext): Promise<Response> {
  const body = await ctx.req.json();

  // Step 1: parse model string
  const resolvedModel = resolveModel(body.model ?? '');

  // Step 2: wajib prefix
  try { requireProviderPrefix(resolvedModel); }
  catch (e) { return error400(e.message); }

  // Step 3: resolve provider
  const provider = getProvider(resolvedModel.providerId!);
  if (!provider) {
    return error400(`Unknown provider: "${resolvedModel.providerId}". Available: ${getAllProviders().map(p => p.id).join(', ')}`);
  }

  // Step 4: resolve model spec dari provider (STRICT, no fallback)
  const modelSpec = provider.getModelRegistry().getSpec(resolvedModel.modelId);
  if (!modelSpec) {
    return error400(`Model "${resolvedModel.modelId}" not found in provider "${resolvedModel.providerId}". Available: ${provider.getModelRegistry().listModelIds().join(', ')}`);
  }

  // Step 5: proceed dengan modelSpec
  // mapper-in menerima modelSpec, bukan raw model string
  const googleBody = mapOpenAIToGoogle(body, modelSpec, sessionId);
  // ...
}
```

### Antigravity Model Registry (`src/providers/antigravity/config/model-specs.ts`)

```typescript
/**
 * Antigravity Provider — Model Registry
 *
 * Ini adalah MIGRASI dari src/config/model-specs.ts.
 * Tapi sekarang strict:
 *   - Tidak ada gptFallbacks (DIHAPUS)
 *   - Tidak ada resolveClaudeModel fuzzy matching (DIHAPUS)
 *   - Setiap model terdaftar explicit dengan spec lengkap
 *   - upstreamModelId menggantikan forceThinkingAliases
 */

import type { IModelRegistry, IModelSpec } from '../../../core/interfaces';
import { join } from 'path';
import { existsSync } from 'fs';

// Model registry — key: modelId (tanpa prefix)
const MODEL_REGISTRY: Record<string, IModelSpec> = {
  // ─── Gemini 3.x ───────────────────────────────────────────────────────────
  'gemini-3.5-flash-low': {
    modelId: 'gemini-3.5-flash-low',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'level',
    thinkingLevel: 'low',
    maxOutputTokens: 64000,
  },
  'gemini-3.5-flash-high': {
    modelId: 'gemini-3.5-flash-high',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'level',
    thinkingLevel: 'high',
    maxOutputTokens: 64000,
  },
  'gemini-3.1-pro': {
    modelId: 'gemini-3.1-pro',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'level',
    thinkingLevel: 'low',
    maxOutputTokens: 64000,
  },
  'gemini-3.1-pro-high': {
    modelId: 'gemini-3.1-pro-high',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'level',
    thinkingLevel: 'high',
    maxOutputTokens: 64000,
  },
  'gemini-3-pro': {
    modelId: 'gemini-3-pro',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'level',
    thinkingLevel: 'low',
    maxOutputTokens: 64000,
  },
  'gemini-3-flash': {
    modelId: 'gemini-3-flash',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
  },
  // ─── Gemini 2.x ───────────────────────────────────────────────────────────
  'gemini-2.5-pro': {
    modelId: 'gemini-2.5-pro',
    pool: 'sandbox',
    isThinking: false,
    maxOutputTokens: 4096,
  },
  'gemini-2.5-flash': {
    modelId: 'gemini-2.5-flash',
    pool: 'sandbox',
    isThinking: false,
    maxOutputTokens: 4096,
  },
  'gemini-2.5-flash-thinking': {
    modelId: 'gemini-2.5-flash-thinking',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'budget',
    thinkingBudget: 16000,
    maxOutputTokens: 64000,
  },
  // ─── Claude (via antigravity / Google Cloud Code) ─────────────────────────
  'claude-sonnet-4-6': {
    modelId: 'claude-sonnet-4-6',
    pool: 'sandbox',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'claude-sonnet-4-6-thinking',  // Google selalu routing ke thinking variant
  },
  'claude-sonnet-4-6-thinking': {
    modelId: 'claude-sonnet-4-6-thinking',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'budget',
    thinkingBudget: 16000,
    maxOutputTokens: 64000,
  },
  'claude-opus-4-6': {
    modelId: 'claude-opus-4-6',
    pool: 'sandbox',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'claude-opus-4-6-thinking',
  },
  'claude-opus-4-6-thinking': {
    modelId: 'claude-opus-4-6-thinking',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'budget',
    thinkingBudget: 32768,
    maxOutputTokens: 64000,
  },
  // ─── GPT-OSS ──────────────────────────────────────────────────────────────
  'gpt-oss-120b': {
    modelId: 'gpt-oss-120b',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 4096,
  },
  'gpt-oss-120b-medium': {
    modelId: 'gpt-oss-120b-medium',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 4096,
  },
};

/**
 * Load overrides dari model-specs.json (opsional, untuk customisasi tanpa edit kode).
 * File ini bisa add/override entries di MODEL_REGISTRY.
 * Format JSON: Record<modelId, Partial<IModelSpec>>
 */
export async function loadModelSpecOverrides(): Promise<void> {
  const paths = [
    existsSync('/app/data') ? '/app/data/providers/antigravity/model-specs.json' : null,
    join(process.cwd(), 'providers', 'antigravity', 'model-specs.json'),
  ].filter(Boolean) as string[];

  for (const path of paths) {
    try {
      const file = Bun.file(path);
      if (!(await file.exists())) continue;
      const overrides: Record<string, Partial<IModelSpec>> = await file.json();
      for (const [id, override] of Object.entries(overrides)) {
        if (MODEL_REGISTRY[id]) {
          Object.assign(MODEL_REGISTRY[id], override);
        } else {
          // New model definition
          MODEL_REGISTRY[id] = { pool: 'sandbox', isThinking: false, maxOutputTokens: 4096, ...override, modelId: id };
        }
      }
      console.log(`[AntigravityModelRegistry] Loaded overrides from ${path}`);
      break;
    } catch (e) {
      console.warn(`[AntigravityModelRegistry] Failed to load overrides from ${path}:`, e);
    }
  }
}

/** IModelRegistry implementation untuk provider antigravity */
export const antigravityModelRegistry: IModelRegistry = {
  getSpec(modelId: string): IModelSpec | null {
    return MODEL_REGISTRY[modelId] ?? null;
    // TIDAK ADA FALLBACK. Tidak ada fuzzy matching. Tidak ada gptFallbacks.
    // Kalau modelId tidak ada di sini → handler return 400.
  },

  listModelIds(): string[] {
    return Object.keys(MODEL_REGISTRY);
  },
};
```

### Mapper-In Menerima `IModelSpec` (bukan raw string)

```typescript
// src/protocols/openai/mapper-in.ts
// SEBELUM: transformToGoogleBody(openaiBody, projectId, isCli, location, sessionId)
// SESUDAH: mapOpenAIToGoogle(openaiBody, modelSpec, sessionId)
//
// modelSpec sudah berisi semua info yang dibutuhkan:
//   - modelSpec.upstreamModelId ?? modelSpec.modelId → Google model ID
//   - modelSpec.pool → 'cli' | 'sandbox'
//   - modelSpec.isThinking → apakah perlu thinkingConfig
//   - modelSpec.thinkingMode → 'budget' | 'level'
//   - modelSpec.thinkingBudget / thinkingLevel → nilai konkret
//   - modelSpec.maxOutputTokens → batas output
//
// Tidak ada lagi:
//   - resolveModelId() (DIHAPUS — prefixnya sudah di-strip sebelum sampai sini)
//   - resolveClaudeModel() (DIHAPUS — sudah ada di registry)
//   - applyThinkingAlias() (DIHAPUS — digantikan oleh upstreamModelId)
//   - getGptFallback() (DIHAPUS — tidak ada fallback)
//   - resolveSandboxTieredModel() (DIHAPUS — tiering sudah explicit di registry)
//   - isNativelySupportedModel() (DIHAPUS — semua model di registry dianggap supported)

export function mapOpenAIToGoogle(
  openaiBody: any,
  modelSpec: IModelSpec,   // ← terima IModelSpec, bukan string
  sessionId: string,
): any {
  // modelID yang dikirim ke Google (pakai upstreamModelId jika ada)
  const googleModelId = modelSpec.upstreamModelId ?? modelSpec.modelId;

  const thinkingBudget = openaiBody.thinking_budget
    ?? openaiBody.thinking?.budget_tokens
    ?? openaiBody.providerOptions?.thinkingBudget;

  const generationConfig: any = {
    temperature: openaiBody.temperature ?? 0.7,
    maxOutputTokens: openaiBody.max_tokens ?? modelSpec.maxOutputTokens,
    topP: openaiBody.top_p ?? 0.95,
    candidateCount: 1,
  };

  if (modelSpec.isThinking) {
    generationConfig.thinkingConfig = { includeThoughts: true };
    if (modelSpec.thinkingMode === 'level') {
      generationConfig.thinkingConfig.thinkingLevel =
        (openaiBody.thinking_level ?? modelSpec.thinkingLevel ?? 'low');
    } else {
      generationConfig.thinkingConfig.thinkingBudget =
        thinkingBudget ?? modelSpec.thinkingBudget ?? 16000;
    }
  }

  // ... rest of transform logic (messages, tools, dll — sama seperti sekarang)
  return {
    model: googleModelId,
    request: { contents: [], generationConfig, /* ... */ },
    // project: diisi oleh executor setelah account dipilih
  };
}
```

### Breaking: Apa yang Dihapus dari `transform.ts`

| Fungsi Lama | Alasan Dihapus | Penggantinya |
|---|---|---|
| `resolveModelId()` | Strip prefix lama (`openai/`, `antigravity-`) — format baru sudah `provider:model` | `resolveModel()` di `core/model-resolver.ts` |
| `resolveClaudeModel()` | Fuzzy matching ke registry — tidak ada fallback lagi | Exact lookup `antigravityModelRegistry.getSpec(modelId)` |
| `applyThinkingAlias()` | Remap model ke thinking variant | `IModelSpec.upstreamModelId` |
| `getGptFallback()` | Fallback model untuk GPT | **DIHAPUS TOTAL** — no fallbacks |
| `resolveSandboxTieredModel()` | Tiered model routing | Tiering explicit di registry (model IDs distinct) |
| `isNativelySupportedModel()` | Check apakah model supported | Semua model di registry = supported |
| `usesThinkingLevel()` | Check apakah model pakai thinkingLevel | `IModelSpec.thinkingMode === 'level'` |
| `getDefaultThinkingLevel()` | Default level global | `IModelSpec.thinkingLevel` per-model |
| `getMaxOutputTokens()` | Max tokens global/thinking | `IModelSpec.maxOutputTokens` per-model |

---

## Phase 1: Modularisasi Struktural

> **Scope**: Pindah file, buat core interfaces, pecah `server.ts`.
> **ZERO fitur baru, ZERO breaking change.**
> Setiap subtask bisa dikerjakan dalam satu agent session.

> [!IMPORTANT]
> **Working Directory**: Semua path `src/...` di plan ini **relatif ke `apps/backend/`**.
> Semua command (`bun x tsc`, `bun test`, `bun run`) dijalankan dari `apps/backend/`.
> Contoh: `src/core/interfaces.ts` = `apps/backend/src/core/interfaces.ts`
> ```bash
> cd apps/backend
> bun x tsc --noEmit --skipLibCheck
> ```

### Checklist Phase 1

#### 1.1 — Buat Core Interfaces & Utilities
- [x] Buat `src/core/interfaces.ts` — semua interface utama + `IModelSpec` + `IModelRegistry` (lihat contoh kode di bawah)
- [x] Buat `src/core/model-resolver.ts` — parse `"antigravity:gemini-3.5-flash"` → `{ providerId, modelId }` + `requireProviderPrefix()` + `ModelPrefixError`
- [x] Buat `src/core/request-context.ts` — type `RequestContext`
- [x] Buat `src/core/registry.ts` — provider & handler registry (Map-based)
- [x] **Verifikasi**: file compile tanpa error (`bun x tsc --noEmit --skipLibCheck`)

#### 1.2 — Migrasi Model Specs ke Provider Antigravity
- [x] Buat direktori `src/providers/antigravity/config/`
- [x] Buat `src/providers/antigravity/config/model-specs.ts` — `antigravityModelRegistry` implementing `IModelRegistry` (lihat contoh kode di bawah)
  - [x] Daftarkan semua model secara explicit dengan `IModelSpec` lengkap incl. `timeoutMs` (menggantikan `config.models.timeouts.*`)
  - [x] Hapus semua concept: `gptFallbacks`, fuzzy `resolveClaudeModel`, `forceThinkingAliases` → gantikan dengan `upstreamModelId`
  - [x] Support runtime overrides via `providers/antigravity/model-specs.json` (opsional)
- [x] **Hapus** `src/config/model-specs.ts`
- [x] **Hapus** `config/model-specs.json`
- [x] **Verifikasi**: `bun x tsc --noEmit --skipLibCheck`

> [!NOTE]
> Task 1.2 tidak perlu update `providers/antigravity/index.ts` dulu — itu dilakukan di task 1.7.
> Cukup pastikan `antigravityModelRegistry` ter-export dari `model-specs.ts` dan compile.

#### 1.3 — Migrasi Provider Antigravity: Auth Layer
- [x] Buat direktori `src/providers/antigravity/auth/`
- [x] Move `src/auth/types.ts` → `src/providers/antigravity/auth/types.ts` (update internal imports)
- [x] Move `src/auth/storage.ts` → `src/providers/antigravity/auth/storage.ts` (update imports)
- [x] Move `src/auth/oauth.ts` → `src/providers/antigravity/auth/oauth.ts` (update imports)
- [x] Move `src/auth/manager.ts` → `src/providers/antigravity/auth/manager.ts` (update imports)
- [x] **Hapus** direktori `src/auth/` setelah semua import diupdate
- [x] **Verifikasi**: `bun x tsc --noEmit --skipLibCheck`

#### 1.4 — Migrasi Provider Antigravity: API & Upstream
- [x] Buat direktori `src/providers/antigravity/api/` dan `src/providers/antigravity/upstream/`
- [x] Move `src/api/quota.ts` → `src/providers/antigravity/api/quota.ts` (update imports)
- [x] Move `src/utils/headers.ts` → `src/providers/antigravity/upstream/headers.ts` (update imports)
- [x] Move `src/utils/errors.ts` → `src/providers/antigravity/upstream/errors.ts` (update imports)
- [x] **Hapus** `src/api/`, `src/utils/headers.ts`, `src/utils/errors.ts`
- [x] **Verifikasi**: `bun x tsc --noEmit --skipLibCheck`

#### 1.5 — Extract Executor dari `server.ts`
- [x] Buat `src/providers/antigravity/upstream/executor.ts` (lihat contoh kode di bawah)
- [x] Extract retry loop dari `server.ts` ke `executor.ts` — preserve **exact** semua error handling
- [x] Executor **menerima `IModelSpec`** (bukan raw model string) untuk timeout, pool, dll:
  - [x] `options.modelSpec.pool` menggantikan keyword-based pool detection
  - [x] `options.modelSpec.timeoutMs ?? 60000` menggantikan `config.models.timeouts.*`
- [x] Inject `project: account.projectId` ke googleBody di dalam executor setelah account dipilih
- [x] `server.ts` call executor, bukan inline retry logic
- [x] **Verifikasi**: curl test dengan `antigravity:gemini-3.5-flash-low` → 200 ✅ streaming OK

#### 1.6 — Migrasi Protocol OpenAI
- [x] Buat direktori `src/protocols/openai/`
- [x] Buat `src/protocols/openai/mapper-in.ts`:
  - [x] Extract logic dari `src/utils/transform.ts` — fungsi utama: `mapOpenAIToGoogle(openaiBody, modelSpec, sessionId)`
  - [x] Signature baru terima `IModelSpec` bukan raw model string (lihat contoh kode)
  - [x] Pindahkan `cache.ts` import ke sini (signature caching tetap di `utils/cache.ts`, import path-nya diupdate)
  - [x] `schema.ts` import dari `utils/schema.ts` (path tidak berubah)
- [x] Buat `src/protocols/openai/mapper-out.ts`:
  - [x] Extract `createOpenAIStreamTransformer()` + `transformGoogleEventToOpenAI()` dari `transform.ts`
  - [x] Cache import diupdate ke path baru jika diperlukan
- [x] Buat `src/protocols/openai/handler.ts` — extract handler dari `server.ts` (baris 96–533):
  - [x] Signature: `mapOpenAIToGoogle(body, modelSpec, sessionId)` (bukan old `transformToGoogleBody`)
  - [x] Path endpoint: `/openai/v1/chat/completions` (hapus `/v1/chat/completions`)
  - [x] Handler call `requireProviderPrefix()` + `provider.getModelRegistry().getSpec()` (return 400 jika null)
- [x] Buat `src/protocols/openai/index.ts` — register handler ke registry
- [x] **Hapus** `src/utils/transform.ts`
- [x] **Verifikasi**: `POST /openai/v1/chat/completions` streaming → 200 ✅, non-streaming → 200 ✅, `POST /v1/chat/completions` → **404** ✅

#### 1.7 — Buat Provider Registration + Config Migration
- [x] Buat `src/providers/antigravity/index.ts` — `AntigravityProvider` class:
  - [x] Implement semua method `IProvider` termasuk `getModelRegistry()`
  - [x] Implement `loadAntigravityConfig()` yang baca `providers/antigravity/config.json`
  - [x] Config antigravity-specific (endpoints, features, quota, scheduling) dibaca dari sini, bukan dari global `config.json`
- [x] **Rename** `antigravity-accounts.json` → `providers/antigravity/accounts.json`
- [x] Update path di `src/providers/antigravity/auth/storage.ts` untuk baca dari path baru
- [x] Buat `providers/antigravity/config.json` — isi dengan field yang dipindahkan dari `config.json`: `endpoints`, `features`, `scheduling`, `quota`, `models.blacklist`
- [x] Update `config.json` — hapus field yang sudah pindah ke provider: `endpoints`, `features`, `scheduling`, `quota`, `models`
- [x] Startup migration di `initManager()`: strip `antigravity-` prefix dari key `modelScores` dan `capabilities` yang ada di `accounts.json`
- [x] Update `src/providers/antigravity/config/model-specs.ts`: implement `getModelRegistry()` di provider
- [x] Register provider ke registry

#### 1.8 — Buat Router & Slim Down `server.ts`
- [x] Buat `src/router/middleware.ts` — cors + request logger + log capture (pindah dari `server.ts`)
- [x] Buat `src/router/admin.ts` — pindahkan semua admin routes dari `server.ts` (baris 535–762)
- [x] Buat `src/router/index.ts` — central dispatcher
- [x] Refactor `src/server.ts` → hanya init + register + start (< 80 baris)
- [x] Update **semua script** di `src/scripts/` untuk pakai path dan model format baru:
  - `test-request.ts`: url `/v1/chat/completions` → `/openai/v1/chat/completions`, model `gemini-2.5-flash-thinking` → `antigravity:gemini-2.5-flash-thinking`
  - Script lain yang import dari `src/auth/*`, `src/api/*`, `src/utils/*`: update imports
- [x] **Rewrite unit tests** (`tests/unit/`):
  - [x] `transform.test.ts` → rewrite total:
    - Import path berubah: `src/utils/transform` → `src/protocols/openai/mapper-in` dan `mapper-out`
    - Signature berubah: `transformToGoogleBody(body, projectId, isCli, location)` → `mapOpenAIToGoogle(body, modelSpec, sessionId)`
    - Test harus pakai `IModelSpec` object bukan raw model string
    - Hapus test "Antigravity model prefix removal" (concept ini tidak ada lagi)
    - Hapus test "Thinking level extraction for CLI" (pool/tier sekarang dari `IModelSpec`, bukan dari model string suffix)
    - Update test "Claude Opus 4.6 Thinking mapping" — pakai `IModelSpec` dengan `upstreamModelId`
    - Tambah test: model tanpa prefix → reject (di handler, bukan di mapper)
  - [x] `manager.test.ts` → rewrite:
    - Import path berubah: `src/auth/manager` → `src/providers/antigravity/auth/manager`
    - `getFamilyName()` sekarang terima bare `modelId` (bukan string dengan `antigravity-` prefix)
    - Update test expectations sesuai model-model yang ada di registry
  - [x] **Tambah test baru** `tests/unit/model-resolver.test.ts`:
    - Test `resolveModel("antigravity:gemini-3.5-flash-low")` → `{ providerId: "antigravity", modelId: "gemini-3.5-flash-low" }`
    - Test `resolveModel("gemini-3.5-flash-low")` → `{ providerId: null, modelId: "gemini-3.5-flash-low" }`
    - Test `requireProviderPrefix()` throw `ModelPrefixError` untuk model tanpa prefix
    - Test `requireProviderPrefix()` pass untuk model dengan prefix
  - [x] **Tambah test baru** `tests/unit/model-registry.test.ts`:
    - Test `antigravityModelRegistry.getSpec("gemini-3.5-flash-low")` → return IModelSpec
    - Test `antigravityModelRegistry.getSpec("nonexistent-model")` → return null
    - Test `antigravityModelRegistry.listModelIds()` → return string[]
- [x] **Rewrite functional tests** (`tests/functional/`):
  - [x] `gemini-functional.test.ts`:
    - URL: `/v1/chat/completions` → `/openai/v1/chat/completions`
    - Model: `gemini-2.0-flash` → `antigravity:gemini-3-flash` (atau model valid lain)
    - Tambah test: request tanpa prefix → expect 400
- [x] **Verifikasi FINAL Phase 1**:
  - [x] `GET /openai/v1/models` → 200 ✅ (return prefixed model IDs `antigravity:*`)
  - [x] `POST /openai/v1/chat/completions` dengan `antigravity:gemini-3.5-flash-low` streaming → 200 ✅
  - [x] `POST /openai/v1/chat/completions` non-streaming → 200 ✅
  - [x] `POST /openai/v1/chat/completions` dengan model tanpa prefix → **400** ✅
  - [x] `POST /openai/v1/chat/completions` dengan model tidak dikenal → **400** ✅
  - [x] `GET /api/status` → 200 ✅
  - [x] `GET /frontend/index.html` → 200 ✅
  - [x] OAuth: `GET /oauth/start` → redirect 302 ✅
  - [x] `POST /v1/chat/completions` → **404** ✅ (intentional break)
  - [x] `GET /v1/models` → **404** ✅ (intentional break)
  - [x] `bun test tests/unit` → 20/20 pass ✅
  - [x] `bun test tests/functional` → 1 pass (prefix test), 5 skip (no accounts / env-specific) ✅
---

## Phase 2: Multi-Protocol API Routing

> **Scope**: Tambah Anthropic protocol handler + modular URL routing.
> **Dependencies**: Phase 1 HARUS selesai terlebih dahulu.

### Checklist Phase 2

#### 2.1 — Anthropic Request Mapper (`mapper-in.ts`)
- [x] Buat `src/protocols/anthropic/mapper-in.ts`
- [x] Implement `mapAnthropicToGoogle(body, modelSpec, sessionId)` — **menerima `IModelSpec`**, bukan raw string:
  - [x] `modelSpec.upstreamModelId ?? modelSpec.modelId` → Google model ID
  - [x] `modelSpec.isThinking` + `modelSpec.thinkingMode` → `thinkingConfig`
  - [x] `modelSpec.maxOutputTokens` → default max tokens
  - [x] Parse `system` field (string atau content array) → `system_instruction`
  - [x] Transform Anthropic `messages` → Google `contents`
  - [x] Handle: `text`, `image` (base64), `tool_use` (functionCall), `tool_result` (functionResponse), `thinking` (thought + thoughtSignature)
  - [x] Handle `tools` → `functionDeclarations` dengan `cleanJSONSchemaForAntigravity`
  - [x] Merge consecutive same-role messages
  - [x] **Tidak inject `project`** — itu tugas executor

#### 2.2 — Anthropic Response Mapper (`mapper-out.ts`)
- [x] Buat `src/protocols/anthropic/mapper-out.ts` (lihat contoh kode lengkap di bawah)
- [x] Implement `createAnthropicStreamTransformer(model, messageId, sessionId)`:
  - [x] Send `message_start` di start
  - [x] Handle text parts → `content_block_start` (type: text) + `content_block_delta` (text_delta)
  - [x] Handle thought parts → `content_block_start` (type: thinking) + `content_block_delta` (thinking_delta)
  - [x] Handle functionCall parts → `content_block_start` (type: tool_use) + `content_block_delta` (input_json_delta)
  - [x] Send `content_block_stop` sebelum block baru
  - [x] Handle finishReason → `message_delta` (stop_reason, usage) + `message_stop`
  - [x] Non-streaming: aggregate semua SSE → single Anthropic response object
  - [x] Map Google finishReason ke Anthropic stop_reason:
    - `STOP` → `end_turn`
    - `MAX_TOKENS` → `max_tokens`
    - `SAFETY` → `stop_sequence`
    - Lainnya → `end_turn`

#### 2.3 — Anthropic Handler
- [x] Buat `src/protocols/anthropic/handler.ts`:
  - [x] Implement `AnthropicHandler` class dengan `IProtocolHandler`
  - [x] Call `requireProviderPrefix()` + `provider.getModelRegistry().getSpec()` (return 400 jika null)
  - [x] Call `mapAnthropicToGoogle(body, modelSpec, sessionId)` — pass `IModelSpec`
  - [x] Execute via `AntigravityExecutor` (executor inject `projectId` dan handle pool via `modelSpec.pool`)
  - [x] Streaming: pipe via `createAnthropicStreamTransformer()`
  - [x] Non-streaming: aggregate via `aggregateAnthropicResponse()`
- [x] Buat `src/protocols/anthropic/index.ts` — register handler
- [x] Import `src/protocols/anthropic` di `server.ts`
- [x] Update `src/scripts/test-request.ts` atau buat `src/scripts/test-anthropic.ts` untuk test Anthropic format

#### 2.4 — Router URL Pattern Update
- [x] Update `src/router/index.ts`:
  - [x] `POST /anthropic/v1/messages` → Anthropic handler
  - [x] `GET /anthropic/v1/models` → model list
  - [x] Tidak ada alias `/v1/messages` — hanya `/anthropic/v1/messages`

#### 2.5 — Testing Phase 2
- [x] Test: `POST /anthropic/v1/messages` dengan `stream: true` → streaming Anthropic SSE
- [x] Test: `POST /anthropic/v1/messages` tanpa stream → single Anthropic response
- [x] Test: tool_use flow dengan Anthropic format
- [x] Test: thinking blocks (extended thinking)
- [x] Test: Claude Code CLI → `ANTHROPIC_BASE_URL=http://localhost:3000/anthropic`
- [x] Verifikasi: `POST /v1/messages` → **404** (no legacy alias)

---

## Phase 3: Provider-Prefixed Model Naming

> **Scope**: Sistem model naming `provider:model-id`. Parse, resolve, expose ke client.
> **Dependencies**: Phase 1 HARUS selesai. Phase 2 direkomendasikan.

### Checklist Phase 3

#### 3.1 — Enforce Model Resolver di Semua Handler
- [x] Verifikasi `src/core/model-resolver.ts` sudah ada (dari Phase 1.1)
- [x] Verifikasi `requireProviderPrefix()` sudah di-call di OpenAI handler (dari Phase 1.6) dan Anthropic handler (dari Phase 2.3)
- [x] Verifikasi `provider.getModelRegistry().getSpec()` sudah di-call di semua handler (return 400 jika null)
- [x] **Verifikasi**: request `antigravity:gemini-3.5-flash-low` → resolve ke `{ providerId: 'antigravity', modelId: 'gemini-3.5-flash-low' }` → `IModelSpec` ditemukan → 200

#### 3.2 — Provider-Aware Account Selection (Clean Up)
- [x] Verifikasi key di `accounts.json` sudah pure `modelId|pool` (migration di `initManager()` dari Phase 1.7)
- [x] Update `getFamilyName()` di `manager.ts`: parameter adalah `resolvedModelId` (tanpa prefix), bukan raw string
- [x] Update `markCooldown()`, `flagAccountChallenge()`, `updateAccountUsage()`: konsisten gunakan `resolvedModelId`
- [x] **Hapus** keyword-based pool routing dari executor jika masih ada — pool sudah dari `modelSpec.pool`
- [x] **Verifikasi**: request dengan model yang ada di registry → cooldown/quota update pakai bare modelId

#### 3.3 — `/v1/models` Enhancement
- [ ] Update `handleModelsList()` di `src/router/index.ts`:
  - Return model IDs dalam format `"antigravity:gemini-3.5-flash"` (prefixed)
  - Juga include `legacy_id` field untuk backward compat
  - Tambah `provider` field di setiap model object
  - Sort by `id`
- [ ] Update `src/providers/antigravity/index.ts`: implement `getSupportedModels()` yang return model IDs dari `supportedModelsCache`

#### 3.4 — Model Specs Update
- [ ] Update `config/model-specs.json`:
  - Semua model ID boleh tetap tanpa prefix (resolver strip prefix sebelum lookup)
- [ ] Update `src/config/model-specs.ts`: fungsi-fungsi resolver sudah menerima `modelId` tanpa prefix (tidak perlu ubah)
- [ ] Update `resolveModelId()` di `mapper-in.ts` (OpenAI): strip provider prefix sebelum resolve ke Google model

#### 3.5 — Testing Phase 3
- [ ] Test: `antigravity:gemini-3.5-flash-low` → route ke provider antigravity, model gemini-3.5-flash-low
- [ ] Test: `antigravity:claude-sonnet-4-6` via `/openai/v1/chat/completions` → works
- [ ] Test: `antigravity:claude-sonnet-4-6` via `/anthropic/v1/messages` → works
- [ ] Test: `GET /openai/v1/models` → return prefixed IDs (`antigravity:*`)
- [ ] **Tidak ada test untuk model tanpa prefix** — format `gemini-3.5-flash-low` (tanpa prefix) tidak didukung lagi
- [ ] Update `src/scripts/test-request.ts` untuk pakai format baru

---

## Phase 4: Frontend Rombak Total

> **Scope**: Rombak total dashboard UI — TailwindCSS 4 + daisyUI 5, mobile-first, provider-isolated navigation.
> **Dependencies**: Phase 1 HARUS selesai. Phase 2 & 3 direkomendasikan.

> [!IMPORTANT]
> Plan lengkap ada di file terpisah: [`FRONTEND_MODULAR_IMPLEMENTATION.md`](./FRONTEND_MODULAR_IMPLEMENTATION.md)
>
> Frontend plan berisi:
> - 7 sub-phase (F1–F7)
> - Struktur file target
> - Layout wireframes (desktop & mobile)
> - Hash-based routing
> - daisyUI component mapping
> - Theme config (dark/light)
> - Backend API endpoints baru yang diperlukan
> - Aturan untuk agent

### Quick Summary

| Sub-Phase | Scope |
|---|---|
| F1 | Setup build pipeline (Tailwind + daisyUI + Bun build) |
| F2 | Layout components (sidebar, drawer, header, shell) |
| F3 | Shared components (api client, SSE, store, health badge, etc.) |
| F4 | Overview & Logs pages |
| F5 | Provider pages (Antigravity: accounts, models, config, quota) |
| F6 | Global config editor, theme, mobile polish, performance |
| F7 | Cleanup — hapus frontend lama |

---

## Reference: Interface Definitions

### `src/core/interfaces.ts`

```typescript
// ============================================================
// Core Interfaces — dibaca semua agent sebelum implementasi
// ============================================================

/**
 * Sebuah "akun" yang dimiliki provider.
 */
export interface IAccount {
  readonly id: string;           // unique identifier (email untuk antigravity)
  readonly providerId: string;   // "antigravity" | "codex" | "cursor"
  healthScore: number;           // 0-100
  lastUsed: number;              // timestamp ms
  capabilities?: Record<string, boolean>;
}

/**
 * Options untuk request akun terbaik dari provider.
 */
export interface AccountRequestOptions {
  pool?: string;                 // "cli" | "sandbox" (antigravity-specific)
  modelId?: string;              // resolved model ID (TANPA provider prefix)
  clientId?: string;             // untuk sticky routing
  excludeIds?: string[];         // akun yang sudah dicoba
  skipRescue?: boolean;
}

/**
 * Provider = sumber credential/akun.
 */
export interface IProvider {
  readonly id: string;           // "antigravity" | "codex" | "cursor"
  readonly displayName: string;

  init(): Promise<void>;
  getBestAccount(options: AccountRequestOptions): Promise<IAccount | null>;
  updateAccountUsage(accountId: string, success: boolean, meta: {
    modelId?: string;
    pool?: string;
    clientId?: string;
    statusCode?: number;
  }): Promise<void>;
  getAccounts(): IAccount[];
  getSupportedModels(): string[];         // return modelId TANPA prefix
}

/**
 * Hasil parsing model string.
 */
export interface ResolvedModel {
  providerId: string | null;     // null = pakai default provider
  modelId: string;               // model ID tanpa prefix
  raw: string;                   // original dari client
}

/**
 * Context request yang sudah di-parse.
 */
export interface RequestContext {
  req: Request;
  url: URL;
  protocol: 'openai' | 'anthropic' | 'gemini' | 'codex';
  resolvedModel: ResolvedModel;
  provider: IProvider;
  sessionId: string;
  clientId: string;
}

/**
 * Protocol Handler = handle satu format API.
 * Handler tidak tahu soal provider — provider dihandle executor.
 */
export interface IProtocolHandler {
  readonly protocol: 'openai' | 'anthropic' | 'gemini' | 'codex';
  readonly paths: string[];
  readonly methods: string[];
  handle(ctx: RequestContext): Promise<Response>;
}

/**
 * Options untuk upstream execution.
 */
export interface UpstreamExecuteOptions {
  googleBody: any;               // Google API request body (sudah di-transform)
  model: string;                 // Original model string dari client
  resolvedModelId: string;       // Model ID TANPA provider prefix
  useCliPool: boolean;
  sessionId: string;
  clientId: string;
  provider: IProvider;
}

/**
 * Result dari upstream execution.
 */
export interface UpstreamResult {
  response: Response;
  accountId: string;
  attempts: number;
}
```

---

### `src/core/model-resolver.ts`

```typescript
import type { ResolvedModel } from './interfaces';

const DEFAULT_PROVIDER = 'antigravity';

/**
 * Parse model string menjadi { providerId, modelId }.
 *
 * Format yang didukung:
 *   "antigravity:gemini-3.5-flash-low"  → { providerId: "antigravity", modelId: "gemini-3.5-flash-low" }
 *   "antigravity:claude-sonnet-4-6"      → { providerId: "antigravity", modelId: "claude-sonnet-4-6" }
 *   "gemini-3.5-flash-low"              → { providerId: null, modelId: "gemini-3.5-flash-low" }
 *   ""                                  → { providerId: null, modelId: "" }
 */
export function resolveModel(raw: string): ResolvedModel {
  const colonIndex = raw.indexOf(':');

  if (colonIndex > 0) {
    const maybeProvider = raw.substring(0, colonIndex);
    const modelId = raw.substring(colonIndex + 1);
    // Hanya treat sebagai provider prefix kalau lowercase alphanumeric
    // (hindari false-positive seperti "http://...")
    if (/^[a-z][a-z0-9_-]*$/.test(maybeProvider)) {
      return { providerId: maybeProvider, modelId, raw };
    }
  }

  // TIDAK ADA FALLBACK — model tanpa prefix langsung error di handler
  // Handler harus cek resolved.providerId === null dan return 400
  return { providerId: null, modelId: raw, raw };
}

/**
 * Validate model string — throw-able di handler.
 * Call ini setelah resolveModel() untuk enforce prefix requirement.
 */
export function requireProviderPrefix(resolved: ResolvedModel): void {
  if (resolved.providerId === null) {
    throw new ModelPrefixError(resolved.raw);
  }
}

export class ModelPrefixError extends Error {
  readonly status = 400;
  constructor(raw: string) {
    super(`Model must include provider prefix. Got: "${raw}". Expected format: "provider:model-id" (e.g. "antigravity:gemini-3.5-flash-low").`);
    this.name = 'ModelPrefixError';
  }
}

/**
 * Dapatkan provider ID efektif (fallback ke default jika tidak ada prefix).
 * @deprecated Jangan pakai ini di handler. Gunakan requireProviderPrefix() + resolvedModel.providerId.
 * Fungsi ini hanya untuk internal lookup yang sudah validated.
 */
export function getEffectiveProvider(resolved: ResolvedModel, defaultProvider = DEFAULT_PROVIDER): string {
  return resolved.providerId ?? defaultProvider;
}

/**
 * Format model ID untuk ditampilkan ke client.
 * "antigravity" + "gemini-3.5-flash" → "antigravity:gemini-3.5-flash"
 */
export function formatModelId(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}
```

---

### `src/core/registry.ts`

```typescript
import type { IProvider, IProtocolHandler } from './interfaces';

// ─── Provider Registry ────────────────────────────────────────────────────────

const providers = new Map<string, IProvider>();

export function registerProvider(provider: IProvider): void {
  if (providers.has(provider.id)) {
    console.warn(`[Registry] Provider "${provider.id}" already registered, overwriting.`);
  }
  providers.set(provider.id, provider);
  console.log(`[Registry] Provider "${provider.id}" (${provider.displayName}) registered.`);
}

export function getProvider(id: string): IProvider | undefined {
  return providers.get(id);
}

export function getDefaultProvider(): IProvider {
  const p = providers.get('antigravity');
  if (!p) throw new Error('[Registry] Default provider "antigravity" not registered!');
  return p;
}

export function getAllProviders(): IProvider[] {
  return Array.from(providers.values());
}

// ─── Handler Registry ─────────────────────────────────────────────────────────

const handlers: IProtocolHandler[] = [];

export function registerHandler(handler: IProtocolHandler): void {
  handlers.push(handler);
  console.log(`[Registry] Handler "${handler.protocol}" registered for paths: ${handler.paths.join(', ')}`);
}

/**
 * Cari handler yang cocok untuk path + method.
 */
export function findHandler(pathname: string, method: string): IProtocolHandler | undefined {
  return handlers.find(h =>
    h.methods.includes(method) &&
    h.paths.some(p => pathname === p)
  );
}

export function getAllHandlers(): IProtocolHandler[] {
  return [...handlers];
}
```

---

### `src/providers/antigravity/index.ts`

```typescript
import { registerProvider } from '../../core/registry';
import type { IProvider, IAccount, AccountRequestOptions } from '../../core/interfaces';
import {
  initManager, getBestAccount, updateAccountUsage, getAccounts
} from './auth/manager';
import { supportedModelsCache } from './api/quota';

class AntigravityProvider implements IProvider {
  readonly id = 'antigravity';
  readonly displayName = 'Antigravity (Google Cloud Code)';

  async init(): Promise<void> {
    await initManager();
    console.log(`[AntigravityProvider] Initialized with ${this.getAccounts().length} accounts.`);
  }

  async getBestAccount(options: AccountRequestOptions): Promise<IAccount | null> {
    const acc = await getBestAccount(
      options.pool as any,
      options.modelId,
      options.clientId,
      options.excludeIds ?? [],
      options.skipRescue ?? true,
    );
    if (!acc) return null;
    return {
      id: acc.email,
      providerId: this.id,
      healthScore: acc.healthScore,
      lastUsed: acc.lastUsed,
      capabilities: acc.capabilities,
      _raw: acc,  // expose raw account untuk executor
    } as any;
  }

  async updateAccountUsage(accountId: string, success: boolean, meta: any): Promise<void> {
    await updateAccountUsage(accountId, success, meta.modelId, meta.pool, meta.clientId, meta.statusCode);
  }

  getAccounts(): IAccount[] {
    return getAccounts().map(acc => ({
      id: acc.email,
      providerId: this.id,
      healthScore: acc.healthScore,
      lastUsed: acc.lastUsed,
    }));
  }

  getSupportedModels(): string[] {
    return Array.from(supportedModelsCache);
  }
}

const _provider = new AntigravityProvider();

export async function registerAntigravityProvider(): Promise<void> {
  registerProvider(_provider);
  await _provider.init();
}

export { _provider as antigravityProvider };
```

---

### `src/providers/antigravity/upstream/executor.ts`

```typescript
/**
 * AntigravityExecutor — implements retry loop untuk provider antigravity.
 *
 * INI ADALAH EXTRACT dari retry loop di server.ts (baris 152–514).
 * Semua logic harus dipreserve exact, hanya dipindah ke sini.
 *
 * Yang perlu di-handle:
 *   - Account selection + rotation
 *   - Retry dengan pool switching
 *   - Error handling: 400, 403, 429, 500, 503
 *   - Rate limit tracking + cooldown
 *   - Timeout management (AbortController)
 *   - Signature preservation across retries
 *   - Systemic error detection (> 2 errors → break)
 */

import type { IProvider, UpstreamExecuteOptions, UpstreamResult } from '../../../core/interfaces';
import { getImpersonationHeaders, getGeminiCliHeaders } from './headers';
import { parseGoogleError } from './errors';
import { getProxyConfig } from '../../../config/manager';
import {
  getBestAccount, updateAccountUsage, markCooldown,
  ensureFingerprint, flagAccountChallenge, flagModelUnsupported,
  getFamilyName, emitAccountFlash
} from '../auth/manager';

export class AntigravityExecutor {
  constructor(private provider: IProvider) {}

  async execute(options: UpstreamExecuteOptions): Promise<UpstreamResult> {
    const config = getProxyConfig();
    const maxAttempts = Math.max(
      config.retry.maxAttempts,
      this.provider.getAccounts().length
    );

    let attempts = 0;
    let useCliPool = options.useCliPool;
    const triedEmails: string[] = [];
    const attemptLogs: Array<{ email: string; status: number; reason: string }> = [];
    let systemicErrorCount = 0;
    let lastStatus = 0;
    let originAccountEmail = '';

    const modelId = options.resolvedModelId;
    const isSandboxOnlyModel = modelId.includes('gpt') || modelId.includes('gemini-3.5') || modelId.includes('gemini-3.1') || modelId.includes('claude');
    const isCliOnlyModel = false;

    while (attempts < maxAttempts) {
      attempts++;

      if (attempts > 1) {
        const delayMs = Math.min(500 * attempts, 3000);
        await new Promise(r => setTimeout(r, delayMs));

        if (!isSandboxOnlyModel && !isCliOnlyModel && lastStatus !== 503) {
          useCliPool = !useCliPool;
          console.log(`[Switch] Switching to ${useCliPool ? 'CLI' : 'Sandbox'} pool for attempt ${attempts}`);
        }
      }

      let account = await getBestAccount(useCliPool ? 'cli' : 'sandbox', modelId, options.clientId, triedEmails, true);

      if (!account && !isSandboxOnlyModel && !isCliOnlyModel) {
        const otherPool = useCliPool ? 'sandbox' : 'cli';
        account = await getBestAccount(otherPool, modelId, options.clientId, triedEmails, true);
        if (account) useCliPool = !useCliPool;
      }

      if (!account) {
        account = await getBestAccount(useCliPool ? 'cli' : 'sandbox', modelId, options.clientId, triedEmails, false);
      }

      if (!account || !account.accessToken) {
        if (attempts < maxAttempts) {
          triedEmails.length = 0;
          continue;
        }
        break;
      }

      const SANDBOX_ENDPOINTS = Array.isArray(config.endpoints.sandbox)
        ? config.endpoints.sandbox : [config.endpoints.sandbox];
      const CLI_ENDPOINTS = Array.isArray(config.endpoints.cli)
        ? config.endpoints.cli : [config.endpoints.cli];

      let GOOGLE_URL: string;
      if (useCliPool) {
        const idx = modelId.includes('claude') ? CLI_ENDPOINTS.length - 1 : Math.min(attempts - 1, CLI_ENDPOINTS.length - 1);
        GOOGLE_URL = CLI_ENDPOINTS[idx];
      } else {
        GOOGLE_URL = SANDBOX_ENDPOINTS[Math.min(attempts - 1, SANDBOX_ENDPOINTS.length - 1)];
      }

      if (lastStatus !== 503) triedEmails.push(account.email);

      ensureFingerprint(account as any);

      const headers = (useCliPool && !modelId.includes('claude'))
        ? getGeminiCliHeaders(account.accessToken!, (account as any).fingerprint)
        : getImpersonationHeaders(account.accessToken!, (account as any).fingerprint, modelId);

      const timeoutKey = Object.keys(config.models.timeouts ?? {})
        .find(k => modelId.includes(k)) ?? 'default';
      const timeoutMs = config.models.timeouts?.[timeoutKey] ?? 30000;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      if (config.features.jitterEnabled) {
        const jitter = config.features.jitterMinMs + Math.random() * (config.features.jitterMaxMs - config.features.jitterMinMs);
        await new Promise(r => setTimeout(r, jitter));
      }

      try {
        const googleRes = await fetch(GOOGLE_URL, {
          method: 'POST',
          headers,
          // ⬇ Inject projectId dari account — ini SATU-SATUNYA tempat projectId di-inject.
          // Mapper hanya bangun structure, tidak tahu soal credential.
          // account.projectId adalah Google Cloud Project ID milik account ini.
          body: JSON.stringify({
            ...options.googleBody,
            request: {
              ...options.googleBody.request,
            },
            project: account.projectId,  // ← inject di sini
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (googleRes.ok) {
          await updateAccountUsage(account.email, true, modelId, useCliPool ? 'cli' : 'sandbox', options.clientId);
          emitAccountFlash(account.email, 'success');
          return { response: googleRes, accountId: account.email, attempts };
        }

        // ─── Error Handling (preserve from server.ts) ─────────────────────
        const errText = await googleRes.text();
        const parsedError = parseGoogleError(errText);
        const status = googleRes.status;
        lastStatus = status;

        console.error(`[Error] Google API (${account.email}) returned ${status}:`, errText.substring(0, 200));
        emitAccountFlash(account.email, 'error');
        attemptLogs.push({ email: account.email, status, reason: parsedError.reason });

        if (status === 403 || status === 404) {
          if (parsedError.isChallengeRequired) {
            flagAccountChallenge(account.email, useCliPool ? 'cli' : 'sandbox', getFamilyName(modelId), {
              type: 'CAPTCHA',
              url: parsedError.validationUrl ?? 'https://cloud.google.com/gemini/docs/codeassist/request-license',
              reason: parsedError.reason,
            });
            continue;
          } else if (parsedError.isModelUnsupported) {
            flagModelUnsupported(account.email, modelId);
          }
          await updateAccountUsage(account.email, false, modelId, useCliPool ? 'cli' : 'sandbox', options.clientId, status);
          return {
            response: new Response(JSON.stringify({
              error: { message: `Access denied: ${parsedError.reason}`, type: 'access_denied', code: status.toString() }
            }), { status, headers: { 'Content-Type': 'application/json' } }),
            accountId: account.email,
            attempts,
          };
        }

        if (status === 500 || status === 503) {
          systemicErrorCount++;
          if (systemicErrorCount > 2) break;
        }

        if (status === 400 && errText.includes('thought_signature')) {
          await updateAccountUsage(account.email, false, modelId, useCliPool ? 'cli' : 'sandbox', options.clientId, status);
          return {
            response: new Response(JSON.stringify({
              error: {
                message: 'This conversation contains function calls without thought signatures. Please start a new conversation.',
                type: 'invalid_request_error',
                code: 'thought_signature_missing',
              }
            }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
            accountId: account.email,
            attempts,
          };
        }

        if (status === 429) markCooldown(account.email, useCliPool ? 'cli' : 'sandbox', getFamilyName(modelId));
        await updateAccountUsage(account.email, false, modelId, useCliPool ? 'cli' : 'sandbox', options.clientId, status);
        continue;

      } catch (e: any) {
        clearTimeout(timeoutId);
        await updateAccountUsage(account.email, false, modelId, useCliPool ? 'cli' : 'sandbox', options.clientId);
        if (attempts < maxAttempts) continue;
        return {
          response: new Response(JSON.stringify({
            error: { message: `Proxy exception: ${e.message}` }
          }), { status: 500, headers: { 'Content-Type': 'application/json' } }),
          accountId: account.email,
          attempts,
        };
      }
    }

    return {
      response: new Response(JSON.stringify({
        error: {
          message: 'Quota Exhausted: All accounts failed or are exhausted.',
          type: 'insufficient_quota',
          code: 'insufficient_quota',
          attempts: attemptLogs,
        }
      }), { status: 429, headers: { 'Content-Type': 'application/json' } }),
      accountId: '',
      attempts,
    };
  }
}
```

---

### `src/protocols/openai/handler.ts` (Contoh)

```typescript
import type { IProtocolHandler, RequestContext } from '../../core/interfaces';
import { resolveModel, getEffectiveProvider } from '../../core/model-resolver';
import { getProvider, getDefaultProvider } from '../../core/registry';
import { mapOpenAIToGoogle } from './mapper-in';
import { createOpenAIStreamTransformer } from './mapper-out';
import { AntigravityExecutor } from '../../providers/antigravity/upstream/executor';

export class OpenAIHandler implements IProtocolHandler {
  readonly protocol = 'openai' as const;
  readonly paths = [
    '/openai/v1/chat/completions',  // ONLY this path — no legacy
  ];
  readonly methods = ['POST'];

  async handle(ctx: RequestContext): Promise<Response> {
    const body = await ctx.req.json() as any;

    // Parse model → provider + modelId
    const resolvedModel = resolveModel(body.model ?? '');

    // ENFORCE: model wajib pakai provider prefix
    try {
      requireProviderPrefix(resolvedModel);
    } catch (e: any) {
      if (e instanceof ModelPrefixError) {
        return new Response(JSON.stringify({
          error: { message: e.message, type: 'invalid_request_error', code: 'model_prefix_required' }
        }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      }
      throw e;
    }

    const provider = getProvider(resolvedModel.providerId!) ?? getDefaultProvider();

    // Session fingerprint dari first user message
    const firstMsg = body.messages?.[0]?.content ?? '';
    const stableSeed = `${ctx.clientId}:${typeof firstMsg === 'string' ? firstMsg : JSON.stringify(firstMsg)}`;
    const sessionId = firstMsg
      ? 'sid-' + new Bun.CryptoHasher('sha256').update(stableSeed).digest('hex').slice(0, 16)
      : crypto.randomUUID();

    const requestId = 'chatcmpl-' + Math.random().toString(36).substring(7);
    const useCliPool = determinePool(resolvedModel.modelId);

    // NOTE: mapOpenAIToGoogle adalah rename dari transformToGoogleBody()
    // Account projectId diambil dari account yang dipilih executor nanti.
    // Kita pass empty projectId dulu, executor yang inject yang benar.
    // ALTERNATIF: executor inject projectId ke googleBody sebelum fetch.
    const googleBody = mapOpenAIToGoogle(body, resolvedModel.modelId, '', useCliPool, sessionId, false);

    const executor = new AntigravityExecutor(provider);
    const result = await executor.execute({
      googleBody,
      model: body.model,
      resolvedModelId: resolvedModel.modelId,
      useCliPool,
      sessionId,
      clientId: ctx.clientId,
      provider,
    });

    if (!result.response.ok) {
      return addCorsHeaders(result.response);
    }

    if (body.stream) {
      const stream = result.response.body!.pipeThrough(
        createOpenAIStreamTransformer(body.model, requestId, false, sessionId)
      );
      return addCorsHeaders(new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Antigravity-Attempts': result.attempts.toString(),
        },
      }));
    } else {
      // Non-streaming: aggregate dari stream
      // (sama dengan logic di server.ts baris 414-497)
      const aggregated = await aggregateStream(result.response, body.model, requestId, sessionId);
      return addCorsHeaders(new Response(JSON.stringify(aggregated), {
        headers: { 'Content-Type': 'application/json', 'X-Antigravity-Attempts': result.attempts.toString() },
      }));
    }
  }
}

function determinePool(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  if (lower.includes('claude') || lower.includes('gpt')) return false;
  return lower.includes('-preview') || lower.includes('gemini-2.0') ||
         lower.includes('gemini-2.5') || (lower.includes('gemini-3') && !lower.includes('flash'));
}

function addCorsHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(res.body, { status: res.status, headers });
}

async function aggregateStream(res: Response, model: string, requestId: string, sessionId: string): Promise<any> {
  // Extract dari server.ts baris 414-497
  // ... aggregate SSE chunks → single response object
  return {};
}
```

---

### `src/protocols/anthropic/mapper-in.ts`

```typescript
import { cleanJSONSchemaForAntigravity } from '../../utils/schema';

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicContent[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: AnthropicTool[];
  thinking?: { type: 'enabled'; budget_tokens: number };
  metadata?: { user_id?: string };
}

export type AnthropicContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'tool_result'; tool_use_id: string; content: string | AnthropicContent[] }
  | { type: 'thinking'; thinking: string; signature: string };

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContent[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: any;
}

export function mapAnthropicToGoogle(
  body: AnthropicRequest,
  resolvedModelId: string,
  projectId: string,
  isCli: boolean,
  sessionId: string,
): any {
  const systemText = extractSystemText(body.system);
  const contents = body.messages.map(transformMessage);
  const mergedContents = mergeConsecutiveMessages(contents);

  const generationConfig: any = {
    temperature: body.temperature ?? 0.7,
    maxOutputTokens: body.max_tokens ?? 8192,
    topP: body.top_p ?? 0.95,
    candidateCount: 1,
  };

  if (body.thinking?.type === 'enabled') {
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: body.thinking.budget_tokens,
    };
  }

  let tools: any[] | undefined;
  if (body.tools?.length) {
    tools = [{
      functionDeclarations: body.tools.map(t => ({
        name: t.name,
        description: t.description ?? '',
        parameters: cleanJSONSchemaForAntigravity(t.input_schema, false),
      })),
    }];
  }

  return {
    project: projectId,
    model: resolvedModelId,
    userAgent: 'antigravity',
    requestId: `agent-${crypto.randomUUID()}`,
    requestType: 'agent',
    request: {
      contents: mergedContents,
      systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
      generationConfig,
      tools,
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      ],
      sessionId,
    },
  };
}

function extractSystemText(system?: string | AnthropicContent[]): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map(c => c.text)
    .join('\n');
}

function transformMessage(msg: AnthropicMessage): { role: string; parts: any[] } {
  const role = msg.role === 'assistant' ? 'model' : 'user';
  const parts: any[] = [];
  const content = typeof msg.content === 'string'
    ? [{ type: 'text' as const, text: msg.content }]
    : msg.content;

  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push({ text: block.text });
        break;
      case 'image':
        parts.push({ inlineData: { mimeType: block.source.media_type, data: block.source.data } });
        break;
      case 'tool_use':
        parts.push({ functionCall: { name: block.name, args: block.input, id: block.id } });
        break;
      case 'tool_result': {
        const txt = typeof block.content === 'string'
          ? block.content
          : (block.content as AnthropicContent[])
              .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
              .map(c => c.text).join('');
        let responseObj: any;
        try { responseObj = JSON.parse(txt); } catch { responseObj = { result: txt }; }
        parts.push({ functionResponse: { name: 'function_result', response: responseObj, id: block.tool_use_id } });
        break;
      }
      case 'thinking':
        parts.push({ thought: true, text: block.thinking, thoughtSignature: block.signature });
        break;
    }
  }

  return { role, parts: parts.length ? parts : [{ text: '.' }] };
}

function mergeConsecutiveMessages(contents: any[]): any[] {
  const merged: any[] = [];
  for (const entry of contents) {
    if (merged.length > 0 && merged[merged.length - 1].role === entry.role) {
      merged[merged.length - 1].parts.push(...entry.parts);
    } else {
      merged.push({ ...entry });
    }
  }
  return merged;
}
```

---

### `src/protocols/anthropic/mapper-out.ts`

```typescript
/**
 * Google SSE → Anthropic SSE transform.
 * Anthropic event sequence:
 *   message_start → content_block_start → content_block_delta(s) → content_block_stop → message_delta → message_stop
 */

export function createAnthropicStreamTransformer(model: string, messageId: string, sessionId?: string) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let blockIndex = 0;
  let currentBlockType: 'text' | 'thinking' | 'tool_use' | null = null;
  let started = false;

  return new TransformStream({
    start(controller) {
      const msgStart = {
        type: 'message_start',
        message: {
          id: messageId, type: 'message', role: 'assistant', model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      };
      controller.enqueue(encoder.encode(sseEvent('message_start', msgStart)));
      started = true;
    },

    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6);
        if (dataStr === '[DONE]') continue;

        try {
          const googleEvent = JSON.parse(dataStr);
          const data = googleEvent.response ?? googleEvent;
          const parts = data.candidates?.[0]?.content?.parts ?? [];
          const finishReason = data.candidates?.[0]?.finishReason;
          const usage = data.usageMetadata;

          for (const part of parts) {
            const isThought = part.thought || part.thoughtText;

            if (part.text && isThought) {
              if (currentBlockType !== 'thinking') {
                if (currentBlockType !== null) {
                  controller.enqueue(encoder.encode(sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })));
                  blockIndex++;
                }
                controller.enqueue(encoder.encode(sseEvent('content_block_start', {
                  type: 'content_block_start', index: blockIndex,
                  content_block: { type: 'thinking', thinking: '' },
                })));
                currentBlockType = 'thinking';
              }
              controller.enqueue(encoder.encode(sseEvent('content_block_delta', {
                type: 'content_block_delta', index: blockIndex,
                delta: { type: 'thinking_delta', thinking: part.text },
              })));
            } else if (part.text) {
              if (currentBlockType !== 'text') {
                if (currentBlockType !== null) {
                  controller.enqueue(encoder.encode(sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })));
                  blockIndex++;
                }
                controller.enqueue(encoder.encode(sseEvent('content_block_start', {
                  type: 'content_block_start', index: blockIndex,
                  content_block: { type: 'text', text: '' },
                })));
                currentBlockType = 'text';
              }
              controller.enqueue(encoder.encode(sseEvent('content_block_delta', {
                type: 'content_block_delta', index: blockIndex,
                delta: { type: 'text_delta', text: part.text },
              })));
            } else if (part.functionCall || part.function_call) {
              const call = part.functionCall ?? part.function_call;
              if (currentBlockType !== null) {
                controller.enqueue(encoder.encode(sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })));
                blockIndex++;
              }
              const toolId = call.id ?? `toolu_${Math.random().toString(36).slice(2, 10)}`;
              controller.enqueue(encoder.encode(sseEvent('content_block_start', {
                type: 'content_block_start', index: blockIndex,
                content_block: { type: 'tool_use', id: toolId, name: call.name, input: {} },
              })));
              const inputStr = typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {});
              controller.enqueue(encoder.encode(sseEvent('content_block_delta', {
                type: 'content_block_delta', index: blockIndex,
                delta: { type: 'input_json_delta', partial_json: inputStr },
              })));
              controller.enqueue(encoder.encode(sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })));
              blockIndex++;
              currentBlockType = null;
            }
          }

          if (finishReason) {
            if (currentBlockType !== null) {
              controller.enqueue(encoder.encode(sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })));
              currentBlockType = null;
            }
            const stopReason = finishReason === 'STOP' ? 'end_turn'
              : finishReason === 'MAX_TOKENS' ? 'max_tokens'
              : 'end_turn';
            controller.enqueue(encoder.encode(sseEvent('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: stopReason, stop_sequence: null },
              usage: { output_tokens: usage?.candidatesTokenCount ?? 0 },
            })));
          }
        } catch (e) { /* ignore */ }
      }
    },

    flush(controller) {
      controller.enqueue(encoder.encode(sseEvent('message_stop', { type: 'message_stop' })));
    },
  });
}

function sseEvent(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Aggregate streaming response menjadi single Anthropic response object.
 * Dipakai untuk non-streaming request.
 */
export async function aggregateAnthropicResponse(
  googleRes: Response,
  model: string,
  messageId: string,
): Promise<any> {
  const decoder = new TextDecoder();
  let text = '';
  let thinking = '';
  const toolUses: any[] = [];
  let stopReason = 'end_turn';
  let inputTokens = 0;
  let outputTokens = 0;

  const reader = googleRes.body!.getReader();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const dataStr = line.slice(6);
      if (dataStr === '[DONE]') continue;
      try {
        const g = JSON.parse(dataStr);
        const data = g.response ?? g;
        for (const part of data.candidates?.[0]?.content?.parts ?? []) {
          if (part.thought && part.text) thinking += part.text;
          else if (part.text) text += part.text;
          else if (part.functionCall || part.function_call) {
            const call = part.functionCall ?? part.function_call;
            toolUses.push({
              type: 'tool_use',
              id: call.id ?? `toolu_${Math.random().toString(36).slice(2, 10)}`,
              name: call.name,
              input: call.args ?? {},
            });
          }
        }
        if (data.candidates?.[0]?.finishReason) {
          const fr = data.candidates[0].finishReason;
          stopReason = fr === 'STOP' ? 'end_turn' : fr === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';
        }
        if (data.usageMetadata) {
          inputTokens = data.usageMetadata.promptTokenCount ?? 0;
          outputTokens = data.usageMetadata.candidatesTokenCount ?? 0;
        }
      } catch (e) { /* ignore */ }
    }
  }

  const content: any[] = [];
  if (thinking) content.push({ type: 'thinking', thinking });
  if (text) content.push({ type: 'text', text });
  content.push(...toolUses);

  return {
    id: messageId,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: toolUses.length > 0 ? 'tool_use' : stopReason,
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}
```

---

### `src/server.ts` (Setelah Refactor — Target < 80 Baris)

```typescript
#!/usr/bin/env bun

// ─── 1. Load config (harus PERTAMA) ──────────────────────────────────────────
import { loadProxyConfig, getProxyConfig } from './config/manager';
import { loadModelSpecs } from './config/model-specs';

await loadProxyConfig();
await loadModelSpecs();

// ─── 2. Setup log capture ─────────────────────────────────────────────────────
import { setupLogCapture } from './router/middleware';
setupLogCapture();

// ─── 3. Register providers ────────────────────────────────────────────────────
import { registerAntigravityProvider } from './providers/antigravity';
await registerAntigravityProvider();

// ─── 4. Register protocol handlers (side-effect imports) ─────────────────────
import './protocols/openai';
import './protocols/anthropic';  // Phase 2+

// ─── 5. Start quota refresh ───────────────────────────────────────────────────
import { refreshAllQuotas } from './providers/antigravity/api/quota';
const config = getProxyConfig();
setInterval(refreshAllQuotas, config.quota.refreshIntervalMs);
refreshAllQuotas();

// ─── 6. Start server ──────────────────────────────────────────────────────────
import { handleRequest } from './router';
const pkg = await Bun.file('package.json').json();

Bun.serve({
  port: 3000,
  hostname: '0.0.0.0',
  idleTimeout: 0,
  fetch: handleRequest,
});

console.log(`Antigravity Proxy v${pkg.version} running on http://0.0.0.0:3000`);
```

---

## Config Isolation: Global vs Per-Provider

> [!IMPORTANT]
> Config dibagi dua level. Jangan campurkan. Provider-specific config tidak boleh ada di global config.

### File Config Baru

```
nougate/
├── config.json                          # GLOBAL proxy config (semua provider baca ini)
├── providers/
│   └── antigravity/
│       ├── accounts.json                # [RENAME dari antigravity-accounts.json]
│       └── config.json                  # [NEW] antigravity-specific config
└── src/
    └── providers/
        └── antigravity/
            └── config/
                ├── model-specs.ts       # inline registry (di-compile)
                └── loader.ts            # load providers/antigravity/config.json + accounts.json
```

### Global `config.json` — Hanya Yang Ini

```jsonc
// config.json — HANYA proxy-level config
// Tidak ada model routing, tidak ada endpoint URLs, tidak ada provider behavior
{
  "rotation": {
    "strategy": "sticky",      // default strategy; bisa di-override per-provider
    "cooldown": {
      "defaultDurationMs": 60000,
      "maxDurationMs": 3600000
    }
  },
  "scoring": {
    "healthRange": { "min": 0, "max": 100, "initial": 100 },
    "penalties": { "apiError": -10, "refreshError": -20, "fatalError": -50, "systemicError": -5 },
    "rewards": { "success": 1 },
    "weights": { "health": 2, "lru": 0.1 }
  },
  "retry": {
    "maxAttempts": 5,
    "transientRetryThresholdSeconds": 5
  },
  "tokens": {
    "expiryBufferMs": 60000
  },
  "logging": {
    "maxBufferSize": 200,
    "enableConsoleCapture": true
  }
}
```

### Per-Provider `providers/antigravity/config.json` — Semua yang Antigravity-Specific

```jsonc
// providers/antigravity/config.json
// Semua yang spesifik ke provider antigravity (Google Cloud Code OAuth)
{
  "quota": {
    "refreshIntervalMs": 300000,
    "initialDelayMs": 10000
  },
  "endpoints": {
    // Endpoint Google API — hanya antigravity yang pakai ini
    "sandbox": [
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse"
    ],
    "cli": [
      "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
    ]
  },
  "features": {
    "googleSearchGrounding": false,
    "groundingMode": "auto",
    "keepThinking": false,
    "sanitizeToolNames": true,
    "pidOffsetEnabled": false,
    "softQuotaThresholdPercent": 90,
    "jitterEnabled": true,
    "jitterMinMs": 2000,
    "jitterMaxMs": 5000
  },
  "scheduling": {
    "mode": "cache_first",
    "maxCacheFirstWaitSeconds": 60,
    "maxRateLimitWaitSeconds": 300
  },
  "models": {
    "blacklist": []
    // Tidak ada routing keywords! Pool routing sudah handled oleh IModelSpec.pool
    // Tidak ada timeouts di sini! Timeout per-model ada di IModelSpec.timeoutMs
  }
}
```

### `providers/antigravity/accounts.json` (Renamed dari `antigravity-accounts.json`)

```
✔️ Tetap di-load hanya oleh antigravity provider — tidak ada provider lain yang tahu file ini
✔️ Auth logic (OAuth, token refresh) tetap di src/providers/antigravity/auth/
✔️ File ini adalah runtime state — ditulis oleh manager.ts, bukan di-commit ke git
```

**Yang perlu diclean di `accounts.json`:**
- `modelScores` keys masih pakai format lama (`"antigravity-gemini-3.5-flash-low|sandbox"`, `"gpt-oss-120b-medium|sandbox"`)
- Setelah Phase 3, format baru: `"gemini-3.5-flash-low|sandbox"` (bare modelId, tanpa provider prefix)
- Alasan: key ini adalah internal state provider, bukan request-level model string. Provider sudah tahu dia siapa.
- Ini dilakukan via **migration** di `initManager()` saat startup: strip `antigravity-` prefix dari semua keys yang ada

### Tabel Klasifikasi Config

| Field | Sekarang | Baru | Alasan |
|---|---|---|---|
| `rotation`, `scoring`, `retry`, `tokens` | `config.json` | `config.json` (tetap global) | Behavior proxy, bukan behavior provider |
| `logging` | `config.json` | `config.json` (tetap global) | Proxy-level |
| `endpoints.sandbox`, `endpoints.cli` | `config.json` | `providers/antigravity/config.json` | Google-specific URL |
| `features.*` | `config.json` | `providers/antigravity/config.json` | Semua feature flags ini antigravity-specific |
| `scheduling` | `config.json` | `providers/antigravity/config.json` | Scheduling logic antigravity-specific |
| `models.routing.*` | `config.json` | **DIHAPUS** | Pool routing sudah di `IModelSpec.pool` |
| `models.timeouts.*` | `config.json` | **Pindah ke `IModelSpec.timeoutMs`** | Per-model timeout, bukan global |
| `models.blacklist` | `config.json` | `providers/antigravity/config.json` | Provider blacklists modelnya sendiri |
| `quota.refreshIntervalMs` | `config.json` | `providers/antigravity/config.json` | Quota fetch logic antigravity-specific |
| `accounts` | `antigravity-accounts.json` | `providers/antigravity/accounts.json` | Provider-isolated storage |

### `IModelSpec` Update: Tambah `timeoutMs`

```typescript
// Tambahkan field ini ke IModelSpec di src/core/interfaces.ts
export interface IModelSpec {
  // ... field lain ...

  /**
   * Request timeout dalam ms untuk model ini.
   * Menggantikan config.models.timeouts.* yang global.
   * Default jika tidak set: 60000 (60 detik)
   */
  timeoutMs?: number;
}

// Contoh di antigravity model registry:
'claude-sonnet-4-6': {
  modelId: 'claude-sonnet-4-6',
  pool: 'sandbox',
  isThinking: false,
  maxOutputTokens: 8192,
  upstreamModelId: 'claude-sonnet-4-6-thinking',
  timeoutMs: 60000,
},
'gemini-3.1-pro-high': {
  modelId: 'gemini-3.1-pro-high',
  pool: 'sandbox',
  isThinking: true,
  thinkingMode: 'level',
  thinkingLevel: 'high',
  maxOutputTokens: 64000,
  timeoutMs: 45000,  // thinking model butuh lebih cepat timeout
},
```

### Config Loading Flow

```typescript
// src/server.ts (startup)
await loadProxyConfig();      // load global config.json
await registerAntigravityProvider();  // di dalam ini:
  // └→ loadAntigravityConfig()    // load providers/antigravity/config.json
  // └→ loadModelSpecOverrides()   // load providers/antigravity/model-specs.json (optional)
  // └→ initManager()              // load providers/antigravity/accounts.json
```

### Auth Isolation per Provider

```
Provider antigravity:
  Auth mechanism: Google OAuth 2.0
  Token storage:  providers/antigravity/accounts.json
  Token refresh:  src/providers/antigravity/auth/oauth.ts
  Account manager: src/providers/antigravity/auth/manager.ts
  Scope: hanya diketahui provider ini

Provider codex (future):
  Auth mechanism: OpenAI API Key
  Token storage:  providers/codex/accounts.json
  Token refresh:  src/providers/codex/auth/refresh.ts
  Account manager: src/providers/codex/auth/manager.ts
  Scope: hanya diketahui provider ini

Provider cursor (future):
  Auth mechanism: Cursor session token
  Token storage:  providers/cursor/accounts.json
  ...

Core/Router: TIDAK TAHU mekanisme auth apapun.
             Hanya tahu IProvider interface.
```

---

## Aturan Penting untuk Agent

> [!IMPORTANT]
> **Baca ini sebelum mulai coding!**

1. **Jangan ubah logic** — Phase 1 hanya PINDAH file, bukan ubah behavior. Semua business logic dari `server.ts` dan `auth/` harus dipreserve **exact**.
2. **Hapus file lama** — Setelah move, HAPUS file aslinya. Tidak ada re-export, tidak ada shim.
3. **No legacy routes** — Tidak ada `/v1/chat/completions`, tidak ada `/v1/messages`, tidak ada `/v1/models`. Hanya `/openai/*` dan `/anthropic/*`.
4. **Test path baru** — Test script harus diupdate ke path baru (`/openai/v1/chat/completions`).
5. **Model string wajib prefix, error 400 jika tidak ada** — Call `requireProviderPrefix(resolvedModel)` di semua handler. Return `{ error: { message, type: 'invalid_request_error', code: 'model_prefix_required' } }` dengan HTTP 400.
6. **projectId inject di executor, bukan di mapper** — Mapper hanya transform format. Executor yang inject `project: account.projectId` ke googleBody setelah account dipilih.
7. **Provider ≠ Protocol** — `protocols/` tidak boleh import dari `providers/` secara langsung. Gunakan `IProvider` interface via context.
8. **resolvedModelId** — Semua internal logic (routing, cooldown, quota) pakai `resolvedModelId` (tanpa prefix), bukan raw model string.
9. **Config isolation** — Global `config.json` hanya untuk `rotation`, `scoring`, `retry`, `tokens`, `logging`. Semua yang provider-specific masuk ke `providers/antigravity/config.json`.
10. **modelScores key format** — Internal key di `accounts.json` pakai bare `modelId|pool` (contoh: `"gemini-3.5-flash-low|sandbox"`). Tidak ada `antigravity-` prefix di internal storage.


## Import Path Convention

```typescript
// BEFORE (path lama)
import { getBestAccount } from '../auth/manager';
import { getImpersonationHeaders } from '../utils/headers';
import { parseGoogleError } from '../utils/errors';
import { fetchQuota } from '../api/quota';

// AFTER (path baru)
import { getBestAccount } from '../providers/antigravity/auth/manager';
import { getImpersonationHeaders } from '../providers/antigravity/upstream/headers';
import { parseGoogleError } from '../providers/antigravity/upstream/errors';
import { fetchQuota } from '../providers/antigravity/api/quota';
```

## Route Table Final (Clean — No Legacy)

```
# ─── AI API ────────────────────────────────────────────────────────
GET  /openai/v1/models           → model listing
POST /openai/v1/chat/completions → OpenAI protocol handler
GET  /anthropic/v1/models        → model listing
POST /anthropic/v1/messages      → Anthropic protocol handler

# ─── Admin API ─────────────────────────────────────────────────────
GET  /api/status                 → status + accounts info
GET  /api/sse                    → realtime SSE (account updates, logs)
GET  /api/config                 → get proxy config
POST /api/config                 → update proxy config
POST /api/strategy               → set account selection strategy
GET  /api/accounts/*             → account management
POST /api/accounts/*             → account management
DELETE /api/accounts/*           → account management

# ─── OAuth ─────────────────────────────────────────────────────────
GET  /oauth/start                → start Google OAuth flow
GET  /oauth-callback             → OAuth callback handler

# ─── Frontend ──────────────────────────────────────────────────────
GET  /frontend/*                 → static frontend files
GET  /                           → redirect to /frontend/index.html

# ─── TIDAK ADA ─────────────────────────────────────────────────────
# ❌ /v1/chat/completions         (removed — breaking change)
# ❌ /v1/messages                 (removed — breaking change)
# ❌ /v1/models                   (removed — breaking change)
# ❌ model string tanpa prefix    (e.g. "gemini-3.5-flash" → error)
```

## Client Configuration Update

Setelah refactor selesai, update konfigurasi client:

```bash
# Cursor / Continue / Zed / OpenAI-compatible clients
base_url = http://localhost:3000/openai
api_key  = sk-anything
model    = antigravity:gemini-3.5-flash-low

# Claude Code CLI
export ANTHROPIC_BASE_URL=http://localhost:3000/anthropic
export ANTHROPIC_API_KEY=sk-anything
# model: antigravity:claude-sonnet-4-6

# Test curl — OpenAI
curl -X POST http://localhost:3000/openai/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"antigravity:gemini-3.5-flash-low","messages":[{"role":"user","content":"hi"}],"stream":true}'

# Test curl — Anthropic
curl -X POST http://localhost:3000/anthropic/v1/messages \
  -H 'Content-Type: application/json' \
  -d '{"model":"antigravity:claude-sonnet-4-6","messages":[{"role":"user","content":"hi"}],"max_tokens":1024,"stream":true}'
```
