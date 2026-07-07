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

## Kesimpulan Rekomendasi
*   **Untuk Keamanan & Keawetan**: Gunakan **iCloud Hide My Email** secara semi-otomatis (reset machine ID otomatis via local script, pendaftaran akun baru manual 30 detik).
*   **Untuk Full Otomatisasi (Script-driven)**: Gunakan **Domain Tumbal ($5/tahun) + Catch-All Routing** untuk menampung verifikasi OTP secara programmatic.
*   **Benteng Utama**: Untuk kebutuhan data pribadi atau dumping harian dengan context besar, tetap gunakan **Antigravity Proxy (Google)** karena sejauh ini masih menjadi opsi paling ekonomis (unlimited/tanpa kuota ketat).
