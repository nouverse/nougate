# Findings & Fixes — Stability Sweep

Hasil audit menyeluruh terhadap provider Antigravity, Copilot, custom provider,
mapper protokol, lapisan metrics, dan CI. Ke-15 temuan **sudah diperbaiki dan diverifikasi**; yang sengaja tidak dikerjakan
dicantumkan terpisah di bawah.

Setiap temuan diverifikasi langsung ke kode sebelum ditulis — tidak ada dugaan.
Perbaikan yang bisa dibuktikan disabotase dulu untuk memastikan test-nya benar-benar
menangkap bug-nya.

**Tanggal:** Agustus 2026 · **Test:** 254 lulus (22 file) · **Typecheck:** bersih backend + frontend

---

## Ringkasan

| # | Temuan | Area | Dampak | Status |
|---|--------|------|--------|--------|
| 1 | Cooldown Copilot ditulis tapi tidak pernah dibaca | Copilot | 🔴 Kritis | ✅ |
| 2 | Tombol Cooldown dashboard Antigravity tidak bekerja | Antigravity | 🟠 Tinggi | ✅ |
| 3 | Satu token mati menghabiskan seluruh retry | Antigravity | 🟠 Tinggi | ✅ |
| 4 | Model tidak didukung di satu akun → request gagal total | Antigravity | 🟠 Tinggi | ✅ |
| 5 | Tanda "model tidak didukung" permanen selamanya | Antigravity | 🟠 Tinggi | ✅ |
| 6 | Outage Google dilaporkan sebagai kuota habis | Antigravity | 🟡 Sedang | ✅ |
| 7 | Copilot tidak punya timeout sama sekali | Copilot | 🔴 Kritis | ✅ |
| 8 | Cooldown custom provider tidak pernah berlaku | Custom | 🟠 Tinggi | ✅ |
| 9 | Token usage hilang di jalur OpenAI→Anthropic | Mappers | 🟠 Tinggi | ✅ |
| 10 | Baris metrics ditandai akurat padahal separuh tebakan | Metrics | 🟡 Sedang | ✅ |
| 11 | Reader stream tidak menutup koneksi upstream saat error | Antigravity | 🟡 Sedang | ✅ |
| 12 | Merge kuota mempertahankan angka paling optimis | Antigravity | 🟢 Rendah | ✅ |
| 13 | Timer timeout menyala sebelum jitter | Antigravity | 🟢 Rendah | ✅ |
| 14 | CI gagal di checkout bersih | CI | 🟠 Tinggi | ✅ |
| 15 | Model tak dikenal membakar seluruh pool Copilot | Copilot | 🟠 Tinggi | ✅ |

---

## Temuan detail

### 1. Cooldown Copilot ditulis tapi tidak pernah dibaca 🔴

**File:** `providers/copilot/upstream/executor.ts:78` · `providers/copilot/auth/manager.ts:157`

Cooldown ditulis dengan kunci model mentah (`id|pool|claude-opus-4.6`), tapi
`getBestAccount` membacanya dengan nama family (`id|pool|Claude/GPT`). Kedua kunci
tidak pernah bertemu.

**Akibat:** setiap 429, akun yang baru saja ditolak langsung dipilih lagi di request
berikutnya. Cooldown Copilot praktis tidak berfungsi sama sekali, dan gateway terus
menghantam upstream yang sudah minta melambat — cara tercepat mendapat ban lebih lama.

**Perbaikan:** kunci tulis dan baca disatukan lewat `cooldownScope(model)`.

---

### 2. Tombol Cooldown dashboard Antigravity tidak bekerja 🟠

**File:** `providers/antigravity/index.ts:598`

```ts
markCooldown(accountId, pool, duration)   // 3 argumen
markCooldown(email, pool, scope, resetTimeStr?)  // 4 parameter
```

`"3600s"` mendarat di slot `scope`. Hasilnya kunci `email|cli|3600s` yang tidak pernah
dicek, dan durasinya memakai default 60 detik, bukan 3600.

**Akibat:** tombol Cooldown di dashboard tidak melakukan apa pun.

**Perbaikan:** memakai `ACCOUNT_WIDE` sebagai scope eksplisit dengan durasi di posisi
yang benar.

---

### 3. Satu token mati menghabiskan seluruh retry 🟠

**File:** `providers/antigravity/auth/manager.ts:375` · `upstream/executor.ts:249`

`ensureAccountReady` mengembalikan `null` saat refresh token gagal, dan
`getBestAccount` meneruskan `null` itu apa adanya. Executor baru mencatat akun ke
`triedEmails` **setelah** pengecekan null — jadi akun rusak itu tidak pernah tercatat
sudah dicoba, tetap berperingkat tinggi, dan dipilih lagi.

**Akibat:** satu akun dengan refresh token mati menghabiskan kelima attempt, masing-masing
dengan round trip ke endpoint token Google plus sleep backoff 500–3000ms, sementara akun
sehat menganggur. Klien melihat request lambat lalu gagal padahal pool sanggup melayani.

**Perbaikan:** `getBestAccount` menyusuri daftar kandidat sampai menemukan yang siap,
dan hanya mengembalikan `null` saat semua habis. Jalur sticky ikut jatuh ke pool normal.

---

### 4. Model tidak didukung di satu akun → request gagal total 🟠

**File:** `providers/antigravity/upstream/executor.ts:341`

Saat Google membalas 403/404 "not found", kode menandai akun lalu **`return`** —
tidak `continue`.

**Akibat:** Antigravity merilis model per akun secara bertahap. Kalau akun yang terpilih
belum punya `gemini-3.1-pro`, klien dapat error, padahal akun lain di pool bisa melayani.
Kegagalan pertama terbuang percuma.

**Perbaikan:** tandai, catat sebagai sudah dicoba, lalu `continue` ke akun berikutnya.

---

### 5. Tanda "model tidak didukung" permanen selamanya 🟠

**File:** `providers/antigravity/auth/manager.ts:521` · `resetAccount:530`

`capabilities[model] = false` ditulis ke `accounts.json` dan **tidak ada satu pun kode
yang menghapusnya**. Tombol **Reset** di dashboard mereset health, cooldown, modelScores,
history, dan challenge — tapi melewatkan `capabilities`.

**Akibat:** satu 404 sesaat membuang akun dari model itu selamanya. Pool menyusut diam-diam
dan tidak pernah pulih. Satu-satunya jalan keluar adalah mengedit `accounts.json` dengan
tangan.

**Perbaikan:** flag punya masa berlaku 6 jam (`capabilityFlaggedAt` + `isModelUnsupportedFor`),
dan `resetAccount` ikut membersihkannya.

> **Catatan migrasi:** flag lama di `accounts.json` tidak punya timestamp. Itu diperlakukan
> sebagai **tidak dipercaya**, bukan "berlaku selamanya" — kalau tidak, bug aslinya tetap
> hidup di setiap deployment yang sudah jalan.

---

### 6. Outage Google dilaporkan sebagai kuota habis 🟡

**File:** `providers/antigravity/upstream/executor.ts:365`, `:525`

Tiga balasan 5xx memicu `break` keluar dari loop retry, dan satu-satunya jalan keluar
adalah response `429 insufficient_quota`.

**Akibat:** klien yang backoff panjang pada 429 diam lama padahal Google cuma tersendat.
Token Metrics mencatat kegagalan Google sebagai kuota kita yang habis — grafiknya berbohong.

**Perbaikan:** keputusan response akhir diekstrak jadi fungsi murni `summarizeExhaustion()`
dengan tiga hasil:

| Sebab | Sebelum | Sekarang |
|---|---|---|
| Upstream 5xx berulang | 429 `insufficient_quota` | **503 `upstream_unavailable`** |
| Tidak ada akun punya model | 429 `insufficient_quota` | **404 `model_not_found`** |
| Kuota benar-benar habis | 429 | 429 + countdown reset |

---

### 7. Copilot tidak punya timeout sama sekali 🔴

**File:** `providers/copilot/upstream/executor.ts`

Setiap model spec Copilot mendeklarasikan `timeoutMs: 60000` — dan **tidak ada satu baris
pun yang membacanya**. Tidak ada `AbortController`. Antigravity dan custom provider
punya; Copilot tidak.

Diperburuk oleh `server.ts:47` yang menyetel `idleTimeout: 0`, jadi tidak ada lapisan
lain yang akan memutus.

**Akibat:** koneksi Copilot yang menggantung membuat request klien menggantung **selamanya**,
sambil menahan slot.

**Perbaikan:** `AbortController` dengan `modelSpec.timeoutMs`, plus penanganan `AbortError`
di catch.

---

### 8. Cooldown custom provider tidak pernah berlaku 🟠

**File:** `providers/custom/executor.ts` — `selectKey()`, `penalize()`

`selectKey` sengaja jatuh kembali ke key yang masih cooldown "rather than failing the
request outright".

**Akibat:** provider dengan satu key mengabaikan cooldown-nya sendiri sepenuhnya. Setelah
429, key di-cooldown 60 detik, lalu request berikutnya memakainya lagi seketika. Sama
seperti temuan #1: menghantam upstream yang baru saja minta melambat.

Ditambah: 503 juga memicu cooldown 60 detik — terlalu kasar untuk error sesaat, dan
membuat provider satu-key offline tanpa alasan.

**Perbaikan:**
- `selectKey` menghormati cooldown; kalau semua sedang cooling, melempar
  `AllKeysCoolingError` yang membawa sisa waktu.
- Hanya **429** yang memicu cooldown. 503 hanya menurunkan health.
- `ProviderUnavailableError` baru di core, dipetakan kedua protocol handler jadi
  **429 + header `Retry-After`** dalam bentuk error sesuai protokol klien — bukan 502
  generik yang terbaca sebagai "gateway rusak".

---

### 9. Token usage hilang di jalur OpenAI→Anthropic 🟠

**File:** `core/mappers/anthropic-to-openai.ts`

Ini jalur yang dilewati **setiap klien Anthropic-native** (Claude Code, Zed) menuju
Copilot atau custom provider bergaya OpenAI.

Pesan difinalisasi begitu `finish_reason` tiba. Tapi OpenAI mengirim total usage di chunk
**berikutnya**. Guard `finished` kemudian memblokir angka aslinya agar tidak pernah
dikirim.

**Akibat:** klien Anthropic dan lapisan metrics kita melihat **nol input token pada hampir
setiap request** lewat jalur ini. Biaya di dashboard under-report secara sistematis.

Bug ini ditemukan **oleh test** saat memverifikasi perbaikan yang lebih kecil — analisis
awal saya hanya menemukan jalur flush, padahal jalur `finish_reason` yang paling sering
terpakai.

**Perbaikan:** satu fungsi `finalize()` yang dipanggil dari `[DONE]` **dan** `flush`, yaitu
setelah usage tiba. `finish_reason` hanya mencatat alasan berhenti dan menutup blok.

---

### 10. Baris metrics ditandai akurat padahal separuh tebakan 🟡

**File:** `core/metrics/tracker.ts` — `absorbUsage()`, `commit()`

`reportedByUpstream` berubah `true` begitu **salah satu** sisi tiba. `commit()` lalu
menandai `estimated: false` sambil diam-diam jatuh ke estimasi untuk sisi yang hilang.

**Akibat:** dashboard menampilkan baris itu sebagai usage sungguhan padahal separuhnya
tebakan — melanggar prinsip "jangan pernah mengarang angka" lewat jalur kode.

**Perbaikan:** sebuah baris hanya akurat bila kedua sisi benar-benar dilaporkan upstream.

---

### 11. Reader stream tidak menutup koneksi upstream saat error 🟡

**File:** `providers/antigravity/index.ts:118` · `mappers/anthropic-out.ts:303`

Dua loop `reader.read()` manual tanpa `try/finally`. Kalau `read()` melempar di tengah
stream, reader tidak pernah dilepas dan response upstream tidak pernah dibatalkan.

**Perbaikan:** `try/finally` dengan `await reader.cancel().catch(() => {})`.

---

### 12. Merge kuota mempertahankan angka paling optimis 🟢

**File:** `providers/antigravity/api/quota.ts:110`

Saat dua model berbagi `limitName`, merge hanya menggabungkan nama dan modelIds;
`remainingFraction` tetap milik model yang diproses pertama.

Praktisnya tidak berbahaya — `limitName` sama berarti bucket kuota sama, jadi angkanya
memang seharusnya identik. Tapi angka ini memberi makan ranking akun dan pengecekan
exhaustion, bukan cuma kartu dashboard.

**Perbaikan:** ambil `remainingFraction` yang lebih rendah.

---

### 13. Timer timeout menyala sebelum jitter 🟢

**File:** `providers/antigravity/upstream/executor.ts:288`

Timer timeout dinyalakan sebelum sleep jitter anti-fingerprint, jadi jitter (sampai 500ms)
memakan jatah timeout request.

**Perbaikan:** timer dinyalakan setelah jitter.

---

### 14. CI gagal di checkout bersih 🟠

**File:** `.github/workflows/test.yml`

Langkah typecheck frontend berjalan **sebelum** `vite build`. `src/routeTree.gen.ts`
di-generate oleh plugin TanStack Router saat build dan **gitignored**, jadi di checkout
bersih `tsc -b` gagal di setiap file route:

```
src/main.tsx(5,27): error TS2307: Cannot find module '@/routeTree.gen'
```

Lokal tidak terlihat karena file-nya sudah ada dari build sebelumnya.

**Perbaikan:** memakai `bun run build` milik frontend, yang sudah berurutan benar
(`vite build && tsc -b`). Diverifikasi dengan menghapus `routeTree.gen.ts` dan menjalankan
ulang seluruh langkah CI.

---

### 15. Model tak dikenal membakar seluruh pool Copilot 🟠

**File:** `providers/copilot/upstream/executor.ts:100` · `auth/manager.ts:322`

Awalnya ini dilaporkan sebagai kode mati: `flagModelUnsupported` diekspor tapi tidak
pernah dipanggil, sementara `getBestAccount` membaca `capabilities[model] === false` yang
tidak pernah ada yang menulis.

Setelah ditelusuri, kode matinya bukan masalahnya — masalahnya adalah **perilaku yang
hilang**. Cabang `!response.ok` di executor memperlakukan 404 sama seperti error lain:
rotasi ke akun berikutnya.

**Akibat:** setiap seat Copilot menanyakan katalog model yang sama, jadi model yang tidak
dikenal ditolak oleh semuanya. Gateway merotasi seluruh akun, memanggil
`updateAccountUsage(false, …)` di tiap akun sehingga **health score semua akun sehat turun
karena salah ketik nama model**, lalu melempar `Upstream request failed after N attempts` —
yang tidak menyebut sebabnya sama sekali.

**Perbaikan:**
- Cabang `!response.ok` mengklasifikasi error. `model_unsupported` → gagal cepat dengan
  `ModelUnavailableError` (404, `model_not_found`), tanpa rotasi dan tanpa menghukum akun.
- `flagModelUnsupported` **dihapus**. Bentuk per-akun salah untuk provider yang katalog
  modelnya sama di semua seat — mempertahankannya hanya mengundang flag yang di-set tangan
  lalu tidak pernah dibersihkan.
- Dua pembaca `capabilities` yang jadi yatim ikut dihapus, jadi tidak ada lagi jejak
  kapabilitas per-akun di Copilot.
- `ProviderResponseError` di core sekarang membawa status **dan** kode klien; kedua
  protocol handler menerjemahkan status apa pun dari provider, bukan hanya 429.

---

## Tidak diperbaiki (sengaja)

| Hal | Alasan |
|---|---|
| `saveAccounts()` tanpa `await` di banyak tempat | Penulisannya debounced dan tidak pernah menolak; menambahkan `await` di fungsi sinkron akan mengubah tanda tangan belasan fungsi tanpa memperbaiki apa pun. |
| `getNextMidnightPT()` mem-parse `toLocaleString` | Rapuh terhadap format ICU (spasi tak-putus di Node 18+), tapi **terbukti benar** di Bun yang kita pakai. Diperiksa langsung, bukan diasumsikan. |
| Context purification & multi-level compression | Ditunda atas permintaan. Keduanya fitur *biaya*, bukan stabilitas — Gemini punya konteks ~1 juta token sehingga batasnya jarang tersentuh. |
| Account warmup, quota scheduler, tool artifact store | Setelah #3 diperbaiki, nilai warmup turun drastis; kuota sudah di-poll tiap 5 menit; artifact store bukan fitur stabilitas. Lihat `docs/ANTIGRAVITY_MANAGER_ADOPTION.md` §7. |

---

## Cakupan test yang ditambahkan

| File | Menguji |
|---|---|
| `upstream-errors.test.ts` | Klasifikasi error: retry / rotate / scope model |
| `cooldown-scope.test.ts` | Kunci cooldown per-model di kedua provider (#1, #2) |
| `account-readiness.test.ts` | Alur seleksi melewati akun yang gagal refresh (#3) |
| `antigravity-resilience.test.ts` | Expiry flag, response exhaustion, merge kuota (#4, #5, #6, #12) |
| `quota-ranking.test.ts` | Kuota masuk skor rotasi, aman saat data kosong |
| `calibrator.test.ts` | Kalibrasi estimasi token, penolakan outlier |
| `stability-fixes.test.ts` | Cooldown custom provider, timeout, cancel reader (#7, #8, #10, #11) |
| `anthropic-stream-usage.test.ts` | Usage bertahan lewat translasi OpenAI→Anthropic (#9) |

Perbaikan #1–#6, #9 diverifikasi dengan **sabotase**: kode dikembalikan ke perilaku lama,
test dipastikan gagal, lalu dikembalikan.

---

## Catatan perubahan perilaku

Tiga perbaikan mengubah apa yang dilihat klien. Semuanya ke arah yang benar, tapi perlu
diketahui sebelum deploy:

1. **Cooldown Copilot sekarang benar-benar berlaku.** Dengan satu akun Copilot, request
   setelah 429 akan gagal alih-alih dicoba ulang ke akun yang sama. Itu memang seharusnya —
   mencoba lagi ke akun yang baru ditolak hanya memperburuk rate limit.
2. **Custom provider satu-key menghormati cooldown-nya.** Setelah 429, request berikutnya
   dalam jendela cooldown dijawab **429 + `Retry-After`** alih-alih diteruskan ke upstream.
3. **Beberapa baris metrics kini ditandai "est".** Bukan regresi — baris itu memang selalu
   sebagian tebakan, hanya saja sebelumnya tidak mengaku.
