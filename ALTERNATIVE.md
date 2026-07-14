# Alternative Bypass Strategies: Copilot & Cursor

Dokumen ini merangkum hasil riset dan brainstorming mengenai alternatif bypass AI coding assistant selain menggunakan Antigravity (Google Cloud Code).

---

## 1. GitHub Copilot Bypass (OpenAI/Claude/Gemini)

Jika memiliki langganan GitHub Copilot aktif ($10/bulan atau gratis via Student/Open-Source Program), kita bisa memanfaatkannya sebagai penyedia model LLM (GPT-4o, Claude 3.5 Sonnet, Gemini 1.5 Pro) untuk aplikasi/IDE lain seperti Cursor atau Continue.

### Cara Kerja:
1. **Auth Token Extraction**: Mengambil Copilot Token dari konfigurasi VS Code lokal (`~/.config/github-copilot/hosts.json`).
2. **Reverse Proxy**: Menjalankan proxy lokal (seperti `copilot-gpt4-service` atau `github-copilot-proxy`) yang mendengarkan request pada format OpenAI API standard, menerjemahkannya ke format Copilot API (`api.githubcopilot.com`), dan menyuntikkan token Copilot tersebut.
3. **Model Aliasing**: Mengonfigurasi client (misal Cursor) untuk nembak ke proxy lokal tersebut dengan menggunakan model alias (misal `cus-claude-3.5-sonnet`).

### Analisis Kelebihan & Kekurangan:
*   **Kelebihan**: Sangat stabil, jarang mengalami perubahan protokol drastis karena di-maintain oleh Microsoft/GitHub.
*   **Kekurangan**: Sejak **1 Juni 2026**, GitHub menerapkan **Usage-Based Billing (AI Credits)**. Penggunaan model flagship (seperti Claude Sonnet) memakan kredit yang cukup mahal. Jika digunakan untuk agentic tools dengan context window besar, jatah kredit bulanan akan cepat habis (*boncos*).

---

## 2. Cursor AI Bypass (Free Trial Reset & Burner Domain)

Bypass ini bertujuan untuk mereset batasan free trial pada Cursor IDE agar bisa menikmati fitur Pro/flagship model secara gratis tanpa batas.

### Strategi Reset Machine ID:
Cursor mendeteksi perangkat fisik menggunakan file konfigurasi lokal `storage.json`. Kita bisa mereset identitas ini secara lokal:
1. Hentikan proses Cursor.
2. Acak nilai UUID pada field telemetry di file:
   `~/Library/Application Support/Cursor/User/globalStorage/storage.json`
   *   `telemetry.macMachineId`
   *   `telemetry.machineId`
   *   `telemetry.devDeviceId`
3. Hapus cache telemetry lokal dan buka kembali Cursor.

### Strategi Penyediaan Email (Pendaftaran Akun Baru):

Untuk mendaftarkan akun baru setelah reset, kita membutuhkan email unik agar tidak terdeteksi duplikasi.

#### Opsi A: iCloud Hide My Email (Manual & Aman)
*   Menggunakan fitur bawaan Apple untuk membuat email acak (misal `random123@icloud.com`).
*   **Kelebihan**: Sangat aman dari pemblokiran domain karena domain `@icloud.com` tidak mungkin di-blacklist oleh Cursor.
*   **Kekurangan**: Sulit diotomatisasi secara penuh karena Apple tidak menyediakan API publik untuk men-generate email tersebut secara instan.

#### Opsi B: Burner Domain / Domain Tumbal (Otomatis & Murah)
*   Menyewa domain murah khusus (misal `.xyz` atau `.top` seharga ~$5/tahun) khusus untuk pendaftaran akun tumbal.
*   Mengonfigurasi **Catch-All Email Routing** (misalnya lewat Cloudflare Email Routing) agar semua email yang dikirim ke `*@domain-tumbal.com` otomatis masuk ke satu inbox utama.
*   **Kelebihan**: Sangat mudah diotomatisasi. Script pendaftaran otomatis (menggunakan browser automation seperti Playwright + Stealth) bisa dengan bebas men-generate email acak (misal `user_abc123@domain-tumbal.com`) dan membaca OTP secara programmatic via IMAP/API.
*   **Kekurangan**: Domain tumbal tersebut berisiko masuk blacklist di database auth Cursor jika terdeteksi pendaftaran massal yang tidak wajar. Namun, karena harga domainnya murah, kita tinggal membeli domain baru jika domain lama ter-blacklist.

---

---

## 3. 9Router Free Forever Providers (Coding Gratis)

Provider AI coding yang **benar-benar gratis** tanpa perlu bypass atau workaround. Ideal untuk development dengan budget terbatas atau sebagai fallback ketika quota provider berbayar habis.

### Top 3 Provider Gratis untuk Coding:

#### 🥇 Qwen (Qwen2.5-Coder)
*   **Provider**: Alibaba Cloud (FREE FOREVER)
*   **Model**: Qwen2.5-Coder (specialized coding model)
*   **Gratis**: Ya, unlimited dengan rate limit wajar
*   **Kualitas**: Model coding terbaik di kategori free
*   **API**: OpenAI-compatible
*   **Implementasi**: Mudah, cukup signup di Alibaba Cloud
*   **Use Case**: Code generation, debugging, refactoring
*   **Website**: https://dashscope.aliyun.com/

#### 🥈 Kiro AI
*   **Provider**: Kiro AI (FREE FOREVER)
*   **Model**: Proprietary coding-focused models
*   **Gratis**: Ya, unlimited
*   **Kualitas**: Good untuk coding tasks
*   **API**: Simple REST API
*   **Implementasi**: Sangat mudah, signup langsung
*   **Use Case**: General coding assistance
*   **Website**: https://kiroai.com/

#### 🥉 Gemini 2.0 Flash
*   **Provider**: Google AI Studio (FREE tier)
*   **Model**: Gemini 2.0 Flash / Gemini 1.5 Pro
*   **Gratis**: 15 requests/minute (sangat cukup untuk personal use)
*   **Kualitas**: Coding capability excellent
*   **API**: Google AI SDK
*   **Implementasi**: Mudah, API key gratis dari Google AI Studio
*   **Use Case**: Code generation, reasoning, multi-modal coding
*   **Website**: https://aistudio.google.com/

### Provider Gratis Lainnya:

#### OpenCode Free
*   **Status**: FREE FOREVER
*   **Specialty**: Coding-specialized
*   **Note**: Good alternative untuk specific coding tasks

#### Cloudflare Workers AI
*   **Status**: FREE (10,000 requests/day)
*   **Models**: CodeLlama, Mistral, Llama variants
*   **Note**: Butuh Cloudflare account, rate limit generous
*   **Website**: https://developers.cloudflare.com/workers-ai/

#### NVIDIA NIM
*   **Status**: FREE tier available
*   **Models**: Powerful enterprise models
*   **Note**: Setup lebih kompleks, tapi worth it untuk production use

#### iFlow
*   **Status**: FREE FOREVER
*   **Note**: Support coding tasks dengan rate limit wajar

### Provider OAuth Subscription (Tidak Direkomendasikan untuk Bypass):

❌ **Cursor IDE** - OAuth subscription, kompleks untuk di-bypass, lebih baik pakai strategy reset di section 2
❌ **Kilo Code** - OAuth subscription, tidak jelas free tier
❌ **Cline** - VS Code extension dengan OAuth, bukan pure API provider

### Analisis Kelebihan & Kekurangan:

**Kelebihan:**
*   **Zero Cost**: Benar-benar gratis tanpa perlu billing info
*   **No Bypass Needed**: Tidak perlu setup proxy, token extraction, atau workaround
*   **Legitimate**: Legal dan sesuai TOS provider
*   **Reliable**: Tidak ada risiko banned karena bypass detection
*   **Good Performance**: Qwen2.5-Coder dan Gemini 2.0 Flash performance mendekati GPT-4 untuk coding tasks

**Kekurangan:**
*   **Rate Limits**: Ada batasan request per menit/hari (tapi cukup untuk personal use)
*   **Model Selection**: Terbatas pada model yang disediakan gratis
*   **Context Window**: Biasanya lebih kecil dari flagship models (tapi Gemini 2M token gratis)
*   **Uptime**: Free tier bisa lebih sering maintenance atau slower response time

### Rekomendasi Strategi Hybrid:

1. **Primary**: Gunakan **Qwen2.5-Coder** atau **Gemini 2.0 Flash** untuk daily coding tasks
2. **Fallback**: **Cloudflare Workers AI** untuk batch processing atau high-volume requests
3. **Premium**: **Copilot/Cursor bypass** untuk complex reasoning atau flagship model needs
4. **Backup**: **Antigravity Proxy** untuk unlimited context atau heavy agentic workflows

---

## Kesimpulan Rekomendasi
*   **Untuk Keamanan & Keawetan**: Gunakan **iCloud Hide My Email** secara semi-otomatis (reset machine ID otomatis via local script, pendaftaran akun baru manual 30 detik).
*   **Untuk Full Otomatisasi (Script-driven)**: Gunakan **Domain Tumbal ($5/tahun) + Catch-All Routing** untuk menampung verifikasi OTP secara programmatic.
*   **Untuk Coding Gratis Legitimate**: Gunakan **Qwen2.5-Coder** atau **Gemini 2.0 Flash** sebagai primary provider untuk daily development.
*   **Benteng Utama**: Untuk kebutuhan data pribadi atau dumping harian dengan context besar, tetap gunakan **Antigravity Proxy (Google)** karena sejauh ini masih menjadi opsi paling ekonomis (unlimited/tanpa kuota ketat).
