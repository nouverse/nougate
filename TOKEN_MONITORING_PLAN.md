# Rencana Implementasi: Token Usage & Cost Monitoring Dashboard

> **Status: SUDAH DIIMPLEMENTASI.** Lihat bagian *Token Usage & Cost Monitoring* di
> [README.md](./README.md) untuk dokumentasi hasil akhirnya.
>
> **Perbedaan dari rencana di bawah:** storage memakai **SQLite (`bun:sqlite`)**, bukan
> PostgreSQL + Drizzle ORM — satu file `data/nougate.db`, tanpa dependensi eksternal, tanpa
> langkah migrasi. Struktur tabel, strategi rollup harian, retensi 14/90 hari, in-memory
> batch queue, dan semua edge case di dokumen ini tetap dipakai apa adanya.
>
> Beberapa hal yang berkembang saat implementasi:
> - Instrumentasi dipasang di **protocol handler**, bukan di response finalizer tiap provider,
>   jadi semua provider (termasuk custom provider) otomatis tercatat.
> - Harga model memakai **price book** terpusat (`core/metrics/price-book.ts`) sebagai fallback
>   sebelum harga default dari config, supaya model yang belum diberi harga tetap masuk akal.
> - Database yang sama juga menyimpan **gateway API keys** dan **custom providers**.
>
> Dokumen ini disimpan sebagai catatan desain awal.

---

Dokumen ini menjelaskan rencana komprehensif untuk menambahkan **Token Usage Monitoring**, **Upstream Cost Tracking**, dan **Headroom Compression Savings** pada semua model di Nougate, yang didukung oleh penyimpanan database PostgreSQL.

---

## 1. Arsitektur & Alur Data

Sistem monitoring ini dirancang agar bersifat **non-blocking** (asinkron), memastikan pencatatan log token tidak mengganggu performa dan ketersediaan utama (core LLM proxy routing).

```mermaid
graph TD
    Client[Client Request] --> Router[Router]
    Router --> Headroom[Headroom Compressor]
    Headroom --> Upstream[Upstream Executor]
    Upstream --> ResponseHandler[Response Handler]
    ResponseHandler --> ClientRes[Client Response]
    
    ResponseHandler -.-> TokenExtractor[Token Extractor]
    TokenExtractor -.-> AsyncQueue[Async Memory Queue]
    AsyncQueue -.-> Worker[Background DB Worker]
    Worker -.-> PostgreSQL[(PostgreSQL Database)]
```

---

## 2. Struktur Database & Skema Drizzle ORM

Kita akan menggunakan PostgreSQL untuk menyimpan data historis dengan retensi maksimum 90 hari, dimodelkan menggunakan **Drizzle ORM**. Untuk memastikan query dashboard berjalan dalam hitungan milidetik bahkan dengan jutaan request, kita menggunakan **dua tabel**: satu untuk log detail jangka pendek, dan satu lagi untuk data agregat jangka panjang (*rollup*).

### 2.1. Skema Tabel Drizzle ORM (`schema.ts`)
Definisi skema tabel menggunakan Drizzle schema builder untuk PostgreSQL:

```typescript
import { pgTable, serial, timestamp, varchar, integer, numeric, date, bigint, primaryKey, index } from 'drizzle-orm/pg-core';

// Tabel Detail Request
export const tokenUsageLogs = pgTable('token_usage_logs', {
  id: serial('id').primaryKey(),
  timestamp: timestamp('timestamp', { withTimezone: true }).defaultNow().notNull(),
  sessionId: varchar('session_id', { length: 64 }),
  clientId: varchar('client_id', { length: 64 }).default('unknown').notNull(),
  provider: varchar('provider', { length: 32 }).notNull(),
  model: varchar('model', { length: 64 }).notNull(),
  fullModelName: varchar('full_model_name', { length: 128 }).notNull(),
  
  // Token Counts
  inputTokens: integer('input_tokens').default(0).notNull(),
  outputTokens: integer('output_tokens').default(0).notNull(),
  tokensBeforeCompression: integer('tokens_before_compression'),
  tokensAfterCompression: integer('tokens_after_compression'),
  tokensSaved: integer('tokens_saved').default(0).notNull(),
  
  // Cost Estimation (USD)
  inputCost: numeric('input_cost', { precision: 12, scale: 6 }).default('0.000000').notNull(),
  outputCost: numeric('output_cost', { precision: 12, scale: 6 }).default('0.000000').notNull(),
  costSaved: numeric('cost_saved', { precision: 12, scale: 6 }).default('0.000000').notNull(),
}, (table) => [
  index('idx_token_logs_timestamp').on(table.timestamp),
  index('idx_token_logs_model').on(table.fullModelName),
  index('idx_token_logs_client').on(table.clientId),
]);

// Tabel Agregasi Harian (Rollup)
export const tokenUsageDailyRollups = pgTable('token_usage_daily_rollups', {
  date: date('date').notNull(),
  provider: varchar('provider', { length: 32 }).notNull(),
  model: varchar('model', { length: 64 }).notNull(),
  fullModelName: varchar('full_model_name', { length: 128 }).notNull(),
  clientId: varchar('client_id', { length: 64 }).notNull(),
  
  totalRequests: integer('total_requests').default(0).notNull(),
  totalInputTokens: bigint('total_input_tokens', { mode: 'number' }).default(0).notNull(),
  totalOutputTokens: bigint('total_output_tokens', { mode: 'number' }).default(0).notNull(),
  totalTokensSaved: bigint('total_tokens_saved', { mode: 'number' }).default(0).notNull(),
  
  totalInputCost: numeric('total_input_cost', { precision: 15, scale: 6 }).default('0.000000').notNull(),
  totalOutputCost: numeric('total_output_cost', { precision: 15, scale: 6 }).default('0.000000').notNull(),
  totalCostSaved: numeric('total_cost_saved', { precision: 15, scale: 6 }).default('0.000000').notNull(),
}, (table) => [
  primaryKey({ columns: [table.date, table.fullModelName, table.clientId] })
]);
```

### 2.2. Konfigurasi Migrasi Drizzle (`drizzle.config.ts`)
Gunakan `drizzle-kit` untuk mengelola pembuatan dan eksekusi migrasi skema database:

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './apps/backend/src/core/schema.ts',
  out: './apps/backend/src/core/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/nougate',
  },
});
```

### 2.3. Mekanisme Retensi & Pruning (90 Hari)
Untuk menghemat kapasitas DB, database runner akan menjalankan pembersihan otomatis terjadwal (CRON) setiap malam menggunakan Drizzle Query/SQL:
1. **Aggregasi/Rollup**: Menghitung total token harian dari `token_usage_logs` untuk hari kemarin dan menyimpannya ke `token_usage_daily_rollups`.
2. **Pruning Detail Log**: Menghapus baris dari `token_usage_logs` yang lebih tua dari **14 hari**. Data grafik tren jangka panjang hingga 90 hari akan tetap aman karena dilayani oleh tabel rollup.
3. **Pruning Rollup Log**: Menghapus data dari `token_usage_daily_rollups` yang umurnya melebihi **90 hari**.

```typescript
// Script Pruning Job via Drizzle (menggunakan raw sql template)
import { db } from './db';
import { sql } from 'drizzle-orm';

async function runPruningJob() {
  // Pruning log detail > 14 hari
  await db.execute(sql`DELETE FROM token_usage_logs WHERE timestamp < NOW() - INTERVAL '14 days'`);
  
  // Pruning rollup harian > 90 hari
  await db.execute(sql`DELETE FROM token_usage_daily_rollups WHERE date < CURRENT_DATE - INTERVAL '90 days'`);
}
```

---

## 3. Integrasi Spesifikasi Harga Model (`IModelSpec`)

Kita menambahkan harga input dan output token per 1 Juta (1M) token di dalam definisi spec model untuk perhitungan biaya yang akurat.

### 3.1. Perubahan Interface
**File:** `apps/backend/src/core/interfaces.ts`
```typescript
export interface IModelSpec {
  // ... existing fields ...
  inputPricePer1M?: number;  // Harga USD per 1M input tokens
  outputPricePer1M?: number; // Harga USD per 1M output tokens
}
```

### 3.2. Penyesuaian Model Registries
Menambahkan definisi harga di config model masing-masing provider.

#### Copilot Registry (`apps/backend/src/providers/copilot/config/model-specs.ts`)
```typescript
const MODEL_REGISTRY: Record<string, IModelSpec> = {
  'gpt-4o': {
    modelId: 'gpt-4o',
    displayName: 'GPT-4o',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 4096,
    upstreamModelId: 'gpt-4o',
    timeoutMs: 60000,
    inputPricePer1M: 2.50,   // $2.50 per 1M tokens
    outputPricePer1M: 10.00, // $10.00 per 1M tokens
  },
  'claude-sonnet-4.5': {
    modelId: 'claude-sonnet-4.5',
    displayName: 'Claude Sonnet 4.5',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'claude-sonnet-4.5',
    timeoutMs: 60000,
    inputPricePer1M: 3.00,
    outputPricePer1M: 15.00,
  },
  'claude-opus-4.5': {
    modelId: 'claude-opus-4.5',
    displayName: 'Claude Opus 4.5',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'claude-opus-4.5',
    timeoutMs: 60000,
    inputPricePer1M: 15.00,
    outputPricePer1M: 75.00,
  },
  'gemini-2.5-pro': {
    modelId: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'gemini-2.5-pro',
    timeoutMs: 60000,
    inputPricePer1M: 1.25,
    outputPricePer1M: 5.00,
  },
  'gpt-5-mini': {
    modelId: 'gpt-5-mini',
    displayName: 'GPT-5 Mini',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'gpt-5-mini',
    timeoutMs: 60000,
    inputPricePer1M: 0.15,
    outputPricePer1M: 0.60,
  }
  // ... dst
};
```

#### Antigravity Registry (`apps/backend/src/providers/antigravity/config/model-specs.ts`)
```typescript
const MODEL_REGISTRY: Record<string, IModelSpec> = {
  'gemini-3-flash': {
    modelId: 'gemini-3-flash',
    displayName: 'Gemini 3 Flash',
    pool: 'sandbox',
    isThinking: false,
    maxOutputTokens: 8192,
    timeoutMs: 60000,
    inputPricePer1M: 0.075,  // $0.075 per 1M tokens
    outputPricePer1M: 0.30,   // $0.30 per 1M tokens
  },
  'claude-sonnet-4-6': {
    modelId: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6 Thinking',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'budget',
    thinkingBudget: 32768,
    maxOutputTokens: 64000,
    timeoutMs: 60000,
    inputPricePer1M: 3.00,
    outputPricePer1M: 15.00,
  }
  // ... dst
};
```

---

## 4. Fitur-Fitur & Penanganan Edge Case

### 4.1. Edge Case Wajib (Mandatory)

1. **Non-Blocking Database Writes (Resilience)**
   * **Masalah**: Jika koneksi PostgreSQL lambat atau mengalami gangguan, proxy tidak boleh memperlambat atau menggagalkan response LLM ke user.
   * **Solusi**: Gunakan *In-Memory Queue* di Node/Bun. Ketika request selesai, data metrik dimasukkan ke antrean lokal dan di-*flush* ke PostgreSQL dalam bentuk *batch insert* secara asinkron setiap 5 detik atau ketika antrean mencapai batas maksimum (misal 50 log). Jika database down, antrean akan menahan log sementara di memori hingga batas buffer tertentu.

2. **Streamed Response Token Monitoring**
   * **Masalah**: Pada request streaming (`stream: true`), token pemakaian (`usage`) terkadang hanya muncul di chunk terakhir, atau malah tidak dikirim sama sekali oleh beberapa upstream provider.
   * **Solusi**: 
     * Membaca properti `usage` dari objek JSON pada chunk akhir jika didukung oleh provider (misal dengan `stream_options: { include_usage: true }`).
     * Jika provider tidak mengembalikan metrik pemakaian pada stream, fallback menggunakan penghitung token sederhana berbasis pustaka (seperti `gpt-3-encoder` atau hitungan perkiraan ~4 karakter per token Inggris) pada teks yang dikumpulkan selama streaming guna mendapatkan estimasi `output_tokens`.

3. **Fallback Pricing untuk Unknown Models (Bypass Mode)**
   * **Masalah**: Jika fitur `bypassModelValidation` diaktifkan, user bisa memakai model yang tidak terdaftar di internal spec. Ini menyebabkan harga input/output bernilai `undefined`.
   * **Solusi**: Sediakan harga fallback default (default input/output price) di dalam environment variables (misal: `DEFAULT_INPUT_PRICE_1M=2.5` & `DEFAULT_OUTPUT_PRICE_1M=10.0`). Jika model spec tidak ditemukan, gunakan harga fallback tersebut sehingga pencatatan biaya tidak bernilai $0 atau error.

4. **Rollup Agregasi Skala Besar**
   * **Masalah**: Melakukan query `COUNT` atau `SUM` langsung pada tabel log detail dengan jutaan baris selama 90 hari untuk memuat dashboard akan membuat database *freeze*.
   * **Solusi**: Dashboard harian/mingguan wajib menarik data dari tabel `token_usage_daily_rollups` yang ukurnya sangat kecil karena sudah dikelompokkan per model, per client, per hari.

5. **Headroom Savings Calculation**
   * **Masalah**: Headroom compression terkadang dibatalkan jika payload tidak didukung atau mengalami error saat pemrosesan.
   * **Solusi**: Selisih token savings harus dipastikan `0` jika transformasi kompresi dilewati. Rumus biaya hemat: `cost_saved = tokens_saved * (inputPricePer1M / 1000000)`.

### 4.2. Edge Case & Fitur Pendukung (Nice-to-Have)

1. **Prompt Caching Discount Support**
   * **Detail**: Model modern (seperti Claude 3.5 Sonnet dan Gemini 1.5/2.5) memberikan diskon harga untuk input token yang terkena cache (*Cache Read* vs *Cache Write*).
   * **Solusi**: Tambahkan kolom opsional `cached_input_tokens` di tabel log detail dan hitung dengan harga diskon (misal, diskon 90% untuk cache read) agar visualisasi penghematan biaya lebih akurat.

2. **Client Token / Spend Budgeting & Alerts**
   * **Detail**: Mengelompokkan konsumsi token per `client_id` (misal: `copilot`, `antigravity`, atau token client custom lainnya).
   * **Solusi**:
     * Visualisasikan biaya pemakaian per client di admin panel.
     * Buat mekanisme notifikasi sederhana jika penggunaan harian client melebihi kuota budget USD yang ditentukan (mencegah *cost overrun* jika ada agent yang terjebak dalam *infinite loop*).

3. **Export History to CSV/JSON**
   * **Detail**: Kebutuhan audit internal atau pelaporan biaya bulanan.
   * **Solusi**: Tambahkan tombol di Dashboard admin untuk mengekspor data penggunaan token dalam bentuk file CSV terfilter berdasarkan rentang tanggal.

---

## 5. Implementasi Backend

### 5.1. File Koneksi Database Drizzle (`apps/backend/src/core/db.ts`)
Menggunakan library Drizzle ORM berbasis driver `postgres` (npm package) yang sangat cepat dan kompatibel dengan Bun.

```typescript
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const dbUrl = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/nougate';

// Inisialisasi pool koneksi
export const client = postgres(dbUrl, {
  max: 10,                 // Maksimum koneksi di pool
  idle_timeout: 20,        // Tutup koneksi jika idle setelah 20 detik
  connect_timeout: 10,     // Timeout koneksi 10 detik
});

export const db = drizzle(client, { schema });
```

### 5.2. Metrics Storage Queue (`apps/backend/src/core/metrics-logger.ts`)
Mengatur penyimpanan log asinkron dengan konsep pooling & batch insert menggunakan Drizzle ORM.

```typescript
import { db } from './db';
import { tokenUsageLogs } from './schema';

interface TokenLogEntry {
  sessionId?: string;
  clientId: string;
  provider: string;
  model: string;
  fullModelName: string;
  inputTokens: number;
  outputTokens: number;
  tokensBeforeCompression?: number;
  tokensAfterCompression?: number;
  tokensSaved: number;
  inputCost: number;
  outputCost: number;
  costSaved: number;
}

class TokenMetricsLogger {
  private queue: TokenLogEntry[] = [];
  private readonly BATCH_LIMIT = 50;
  private readonly FLUSH_INTERVAL_MS = 5000;
  private timer: Timer | null = null;

  constructor() {
    this.startFlushTimer();
  }

  public log(entry: TokenLogEntry) {
    this.queue.push(entry);
    if (this.queue.length >= this.BATCH_LIMIT) {
      this.flush();
    }
  }

  private startFlushTimer() {
    this.timer = setInterval(() => this.flush(), this.FLUSH_INTERVAL_MS);
  }

  private async flush() {
    if (this.queue.length === 0) return;

    const batch = [...this.queue];
    this.queue = [];

    try {
      // Melakukan bulk insert secara efisien dengan Drizzle ORM
      await db.insert(tokenUsageLogs).values(batch);
    } catch (error) {
      console.error('[MetricsLogger] Gagal menyimpan log token ke DB:', error);
      // Fallback: Kembalikan log ke antrean agar tidak hilang jika database down sementara
      this.queue.unshift(...batch);
      
      // Batasi ukuran antrean maksimum agar memori tidak bocor
      if (this.queue.length > 2000) {
        this.queue = this.queue.slice(0, 2000);
      }
    }
  }
}

export const tokenMetricsLogger = new TokenMetricsLogger();
```

### 5.3. API Endpoint untuk Dashboard (`apps/backend/src/router/admin.ts`)
Endpoint ini akan melayani data agregat untuk chart dan statistik menggunakan Drizzle query builder.

```typescript
import { db } from "@/core/db";
import { tokenUsageLogs, tokenUsageDailyRollups } from "@/core/schema";
import { sql, desc, asc, gte, and, eq } from "drizzle-orm";

// GET /api/metrics/token-usage?lookback=7d&clientId=all
if (url.pathname === "/api/metrics/token-usage" && req.method === "GET") {
  const lookback = url.searchParams.get("lookback") || "24h"; // 24h, 7d, 14d, 30d, 60d, 90d
  const clientId = url.searchParams.get("clientId") || "all";
  
  let intervalVal = '1 day';
  let useRollup = false;
  
  switch(lookback) {
    case '24h': intervalVal = '1 day'; break;
    case '7d': intervalVal = '7 days'; break;
    case '14d': intervalVal = '14 days'; break;
    case '30d': intervalVal = '30 days'; useRollup = true; break;
    case '60d': intervalVal = '60 days'; useRollup = true; break;
    case '90d': intervalVal = '90 days'; useRollup = true; break;
  }

  try {
    let usageData;
    let modelStats;
    const filterInterval = sql`CURRENT_DATE - ${sql.raw(`INTERVAL '${intervalVal}'`)}`;
    const filterIntervalLogs = sql`NOW() - ${sql.raw(`INTERVAL '${intervalVal}'`)}`;

    if (useRollup) {
      // Query dari tabel rollup dengan Drizzle ORM
      let rollupConditions = gte(tokenUsageDailyRollups.date, filterInterval);
      if (clientId !== 'all') {
        rollupConditions = and(rollupConditions, eq(tokenUsageDailyRollups.clientId, clientId))!;
      }

      usageData = await db
        .select({
          period: sql`date_trunc('day', ${tokenUsageDailyRollups.date})`.as('period'),
          totalTokens: sql`SUM(${tokenUsageDailyRollups.totalInputTokens} + ${tokenUsageDailyRollups.totalOutputTokens})`.as('total_tokens'),
          tokensSaved: sql`SUM(${tokenUsageDailyRollups.totalTokensSaved})`.as('tokens_saved'),
          totalCost: sql`SUM(${tokenUsageDailyRollups.totalInputCost} + ${tokenUsageDailyRollups.totalOutputCost})`.as('total_cost'),
          costSaved: sql`SUM(${tokenUsageDailyRollups.totalCostSaved})`.as('cost_saved')
        })
        .from(tokenUsageDailyRollups)
        .where(rollupConditions)
        .groupBy(sql`period`)
        .orderBy(asc(sql`period`));
      
      modelStats = await db
        .select({
          fullModelName: tokenUsageDailyRollups.fullModelName,
          requests: sql`SUM(${tokenUsageDailyRollups.totalRequests})`.as('requests'),
          totalTokens: sql`SUM(${tokenUsageDailyRollups.totalInputTokens} + ${tokenUsageDailyRollups.totalOutputTokens})`.as('total_tokens'),
          totalCost: sql`SUM(${tokenUsageDailyRollups.totalInputCost} + ${tokenUsageDailyRollups.totalOutputCost})`.as('total_cost')
        })
        .from(tokenUsageDailyRollups)
        .where(rollupConditions)
        .groupBy(tokenUsageDailyRollups.fullModelName)
        .orderBy(desc(sql`total_tokens`));
    } else {
      // Query dari tabel log mentah untuk grafik 24 jam / jangka pendek yang presisi
      const timeGroup = lookback === '24h' ? 'hour' : 'day';
      let logConditions = gte(tokenUsageLogs.timestamp, filterIntervalLogs);
      if (clientId !== 'all') {
        logConditions = and(logConditions, eq(tokenUsageLogs.clientId, clientId))!;
      }

      usageData = await db
        .select({
          period: sql`date_trunc(${timeGroup}, ${tokenUsageLogs.timestamp})`.as('period'),
          totalTokens: sql`SUM(${tokenUsageLogs.inputTokens} + ${tokenUsageLogs.outputTokens})`.as('total_tokens'),
          tokensSaved: sql`SUM(${tokenUsageLogs.tokensSaved})`.as('tokens_saved'),
          totalCost: sql`SUM(${tokenUsageLogs.inputCost} + ${tokenUsageLogs.outputCost})`.as('total_cost'),
          costSaved: sql`SUM(${tokenUsageLogs.costSaved})`.as('cost_saved')
        })
        .from(tokenUsageLogs)
        .where(logConditions)
        .groupBy(sql`period`)
        .orderBy(asc(sql`period`));
      
      modelStats = await db
        .select({
          fullModelName: tokenUsageLogs.fullModelName,
          requests: sql`COUNT(*)`.as('requests'),
          totalTokens: sql`SUM(${tokenUsageLogs.inputTokens} + ${tokenUsageLogs.outputTokens})`.as('total_tokens'),
          totalCost: sql`SUM(${tokenUsageLogs.inputCost} + ${tokenUsageLogs.outputCost})`.as('total_cost')
        })
        .from(tokenUsageLogs)
        .where(logConditions)
        .groupBy(tokenUsageLogs.fullModelName)
        .orderBy(desc(sql`total_tokens`));
    }

    return createJsonResponse({ usageData, modelStats });
  } catch (error: any) {
    return createJsonResponse({ error: error.message }, 500);
  }
}
```

---

## 6. Desain Antarmuka Dashboard UI (Frontend)

Kita akan membuat halaman dashboard `/tokens` menggunakan TanStack Router dan DaisyUI.

### 6.1. Halaman Dashboard UI Layout
```
┌────────────────────────────────────────────────────────────────────────────┐
│  📊 Token Usage & Cost Analytics Dashboard                                 │
├────────────────────────────────────────────────────────────────────────────┤
│  Filter Waktu: [ Last 24h ] [ 7d ] [ 14d ] [ 30d ] [ 60d ] [ 90d ]         │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐ ┌──────────────┐ │
│  │ Total Spend    │ │ Avg Savings %  │ │ Tokens Saved   │ │ Requests     │ │
│  │ $142.50        │ │ 32.4%          │ │ 8.4M tokens    │ │ 42,105       │ │
│  │ (Orig: $210.8) │ │                │ │ ~$68.30 USD    │ │              │ │
│  └────────────────┘ └────────────────┘ └────────────────┘ └──────────────┘ │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  📈 Spend & Savings Trend                                            │  │
│  │                                                                      │  │
│  │  [ Line Chart: Menampilkan biaya akumulatif & penghematan per hari]  │  │
│  │                                                                      │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  ┌──────────────────────────────────────┐ ┌─────────────────────────────┐  │
│  │  🎯 Top Models by Usage              │ │ 📂 Provider Breakdown       │  │
│  │                                      │ │                             │  │
│  │  antigravity:gemini-3-flash   5.2M   │ │  antigravity  █████████ 65% │  │
│  │  copilot:gpt-4o               2.1M   │ │  copilot      █████     35% │  │
│  │  antigravity:claude-sonnet    1.1M   │ │                             │  │
│  │                                      │ │                             │  │
│  └──────────────────────────────────────┘ └─────────────────────────────┘  │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

### 6.2. Implementasi Grafik SVG (Zero-Dependency Chart)
Untuk menghindari overhead library chart besar seperti Recharts (dan isu kompatibilitas React 19), kita bisa merancang grafik garis/area yang responsive langsung menggunakan native SVG.

Contoh visualisasi chart area dengan Tailwind CSS:
```tsx
export function SparklineChart({ data, width = 600, height = 200 }) {
  if (!data || data.length === 0) return <div>No data available</div>;

  const maxVal = Math.max(...data.map(d => d.value), 1);
  const minVal = Math.min(...data.map(d => d.value), 0);
  const range = maxVal - minVal;

  const points = data.map((d, index) => {
    const x = (index / (data.length - 1)) * width;
    const y = height - ((d.value - minVal) / range) * height;
    return `${x},${y}`;
  }).join(' ');

  const fillPoints = `0,${height} ${points} ${width},${height}`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full">
      {/* Area Gradient */}
      <polygon points={fillPoints} fill="url(#chartGrad)" className="opacity-20" />
      {/* Line */}
      <polyline points={points} fill="none" stroke="var(--color-primary)" strokeWidth="3" />
      <defs>
        <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-primary)" />
          <stop offset="100%" stopColor="transparent" />
        </linearGradient>
      </defs>
    </svg>
  );
}
```

---

## 7. Checklist Implementasi & Rencana Rilis

### Tahap 1: Setup Database, Drizzle ORM & Perubahan Spesifikasi
- [ ] Daftarkan dependensi `"drizzle-orm"`, `"postgres"` dan devDependensi `"drizzle-kit"` di `apps/backend/package.json`.
- [ ] Buat file skema Drizzle `schema.ts` di `apps/backend/src/core/schema.ts` yang berisi `tokenUsageLogs` dan `tokenUsageDailyRollups`.
- [ ] Buat file konfigurasi Drizzle `drizzle.config.ts` di root backend.
- [ ] Lakukan inisialisasi & migrasi database menggunakan `drizzle-kit generate` dan `drizzle-kit migrate` (atau script sinkronisasi manual jika di production).
- [ ] Ubah interface `IModelSpec` di `src/core/interfaces.ts` untuk mendukung properti `inputPricePer1M` dan `outputPricePer1M`.
- [ ] Tambahkan data pricing ke file `model-specs.ts` milik Copilot dan Antigravity provider.

### Tahap 2: Backend Data Collection & Logging (Drizzle)
- [ ] Buat file koneksi database `db.ts` dan modul logger asinkron `metrics-logger.ts` menggunakan Drizzle ORM.
- [ ] Modifikasi Response Finalizer di provider Copilot (`finalizeOpenAIResponse` & stream transformer) untuk mengekstrak token pemakaian dan memicu penyimpanan metrics.
- [ ] Modifikasi Response Finalizer di provider Antigravity (`finalizeOpenAIResponse` / `finalizeAnthropicResponse` & stream) untuk mencatat pemakaian.
- [ ] Implementasi scheduler / cron di Bun untuk proses daily rollup agregasi data dan pruning logs di atas 90 hari via Drizzle SQL execution.

### Tahap 3: API & Dashboard UI
- [ ] Tambahkan endpoint admin GET `/api/metrics/token-usage` untuk melayani kebutuhan visualisasi data tren token.
- [ ] Buat route baru di frontend `/tokens` menggunakan TanStack Router.
- [ ] Rancang dashboard dengan DaisyUI stats card (Total Spend, Tokens Saved, Efficiency %).
- [ ] Rancang grafik SVG untuk visualisasi trend penggunaan token.
- [ ] Tambahkan tombol navigasi "Token Metrics" pada layout Sidebar dashboard admin.

---
**Target Keberhasilan:** Admin panel dapat memvisualisasikan seluruh pemakaian token dan estimasi pengeluaran secara real-time, melihat model yang paling sering digunakan lengkap dengan prefix provider-nya, serta memantau efektivitas penghematan (ROI) dari kompresi Headroom secara presisi dan cepat tanpa memberatkan runtime proxy server.
