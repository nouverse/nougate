# Rencana Refactor: Admin Router Endpoint Generalization

Dokumen ini menjelaskan rencana refactor endpoint-endpoint di `apps/backend/src/router/admin.ts` yang saat ini masih Google/Antigravity-centric menjadi benar-benar provider-agnostic.

---

## 1. Masalah Saat Ini

Admin router (`admin.ts`) mengekspos beberapa endpoint yang namanya *bocor* implementasi internal Antigravity (Google):

| Endpoint | Masalah |
|---|---|
| `POST /api/accounts/:id/project/rediscover` | Istilah "project" & "rediscover" adalah konsep Google Cloud Project — tidak relevan untuk provider lain |
| `POST /api/accounts/:id/project` | Sama, hardcode noun Google Cloud |
| `POST /api/accounts/:id/cooldown` | Acceptable, tapi masih hardcoded pool `cli` di body |
| `POST /api/accounts/:id/reset` | Generic tapi terpencar, tidak ada satu titik entry yang konsisten |
| `DELETE /api/accounts/:id` | OK, tapi perlu dicek konsistensi namespace |

Selain itu, di `IProvider` interface (`apps/backend/src/core/interfaces.ts`) juga terdapat method yang sangat spesifik:
```typescript
updateAccountProject?(accountId: string, projectId: string): Promise<void>;
rediscoverAccountProject?(accountId: string): Promise<any>;
```
Method ini hanya masuk akal untuk Antigravity/Google, bukan untuk provider lain.

---

## 2. Desain Solusi: Action Dispatcher Pattern (Provider-Segmented)

### Konsep
Semua operasi per-akun yang bersifat "action" dikonsolidasikan ke satu endpoint generic **per-provider**:

```
POST /api/providers/:providerId/accounts/:accountId/action
Body: { "action": "<action_name>", "payload": { ... } }
```

Router akan:
1. Identify provider by `:providerId` path segment
2. Validate provider exists
3. Delegate action ke provider via method `handleAccountAction`

**Benefits:**
- ✅ Provider isolation — no account ID collision
- ✅ Explicit provider scoping — RESTful & clear intent
- ✅ Safe for future multi-tenant scenarios

### Mapping Aksi Lama → Baru

| Endpoint Lama | Endpoint Baru | Action Name | Payload |
|---|---|---|---|
| `POST /api/accounts/:id/reset` | `POST /api/providers/:providerId/accounts/:id/action` | `reset` | `{}` |
| `POST /api/accounts/:id/cooldown` | `POST /api/providers/:providerId/accounts/:id/action` | `cooldown` | `{ pool?: string, duration?: string }` |
| `POST /api/accounts/:id/project` | `POST /api/providers/antigravity/accounts/:id/action` | `update_project` | `{ projectId: string }` |
| `POST /api/accounts/:id/project/rediscover` | `POST /api/providers/antigravity/accounts/:id/action` | `rediscover_project` | `{}` |
| `DELETE /api/accounts/:id` | `DELETE /api/providers/:providerId/accounts/:id` | *(endpoint, not action)* | - |
| `POST /api/accounts/reset-all` | `POST /api/accounts/reset-all` | *(tetap, sudah OK)* | - |

---

## 3. Perubahan yang Diperlukan

### Phase 1: Interface & Core

- [ ] Tambahkan method `handleAccountAction` ke `IProvider` interface di `apps/backend/src/core/interfaces.ts`:
  ```typescript
  handleAccountAction?(accountId: string, action: string, payload?: any): Promise<any>;
  ```
- [ ] Hapus (atau deprecate dengan comment) method spesifik berikut dari `IProvider`:
  ```typescript
  updateAccountProject?(accountId: string, projectId: string): Promise<void>;
  rediscoverAccountProject?(accountId: string): Promise<any>;
  ```

### Phase 2: Provider Implementation

- [ ] Implementasikan `handleAccountAction` di `AntigravityProvider`:
  ```typescript
  async handleAccountAction(accountId: string, action: string, payload?: any): Promise<any> {
    switch (action) {
      case 'reset':       return this.resetAccount(accountId);
      case 'cooldown':    return this.markAccountCooldown(accountId, payload?.pool || 'cli', payload?.duration || '3600s');
      case 'update_project':     return this.updateAccountProject(accountId, payload?.projectId);
      case 'rediscover_project': return this.rediscoverAccountProject(accountId);
      default:            throw new Error(`Unknown action: ${action}`);
    }
  }
  ```
- [ ] Implementasikan `handleAccountAction` di `CopilotProvider`:
  ```typescript
  async handleAccountAction(accountId: string, action: string, payload?: any): Promise<any> {
    switch (action) {
      case 'reset':    return this.resetAccount(accountId);
      case 'cooldown': return this.markAccountCooldown(accountId, payload?.pool || 'cli', payload?.duration || '3600s');
      default:         throw new Error(`Action "${action}" not supported for Copilot provider`);
    }
  }
  ```

### Phase 3: Router Cleanup

- [x] Di `apps/backend/src/router/admin.ts`, ganti semua endpoint action yang ada dengan handler **provider-segmented**:
  ```typescript
  // POST /api/providers/:providerId/accounts/:accountId/action
  if (
    url.pathname.match(/^\/api\/providers\/[^\/]+\/accounts\/[^\/]+\/action$/) &&
    req.method === "POST"
  ) {
    const parts = url.pathname.split("/");
    const providerId = parts[3];
    const accountId = decodeURIComponent(parts[5]);

    const body = await req.json() as { action: string; payload?: any };
    if (!body.action) {
      return new Response("Missing action", { status: 400 });
    }

    const p = getAllProviders().find((provider) => provider.id === providerId);
    if (!p) {
      return new Response("Provider not found", { status: 404 });
    }
    if (!p.handleAccountAction) {
      return new Response("Provider does not support account actions", { status: 400 });
    }

    try {
      const result = await p.handleAccountAction(accountId, body.action, body.payload);
      return createJsonResponse(result ?? { ok: true });
    } catch (error: any) {
      return new Response(error.message, { status: 500 });
    }
  }

  // DELETE /api/providers/:providerId/accounts/:accountId
  if (
    url.pathname.match(/^\/api\/providers\/[^\/]+\/accounts\/[^\/]+$/) &&
    req.method === "DELETE"
  ) {
    const parts = url.pathname.split("/");
    const providerId = parts[3];
    const accountId = decodeURIComponent(parts[5]);

    const p = getAllProviders().find((provider) => provider.id === providerId);
    if (!p || !p.removeAccount) {
      return new Response("Provider not found or does not support removal", { status: 404 });
    }

    await p.removeAccount(accountId);
    return new Response("OK", { status: 200 });
  }
  ```
- [x] Hapus 4 endpoint lama:
  - `POST /api/accounts/:id/reset`
  - `POST /api/accounts/:id/cooldown`
  - `POST /api/accounts/:id/project`
  - `POST /api/accounts/:id/project/rediscover`
  - `DELETE /api/accounts/:id` (moved to provider-scoped)

### Phase 4: Frontend Update

- [x] Update semua pemanggilan API di `AntigravityAccountsTab.tsx`:
  - `api.post('/api/accounts/${email}/cooldown', { pool })` → `api.post('/api/providers/antigravity/accounts/${email}/action', { action: 'cooldown', payload: { pool } })`
  - `api.post('/api/accounts/${email}/reset')` → `api.post('/api/providers/antigravity/accounts/${email}/action', { action: 'reset' })`
  - `api.post('/api/accounts/${email}/project/rediscover')` → `api.post('/api/providers/antigravity/accounts/${email}/action', { action: 'rediscover_project' })`
  - `api.delete('/api/accounts/${email}')` → `api.delete('/api/providers/antigravity/accounts/${email}')`
- [x] Update semua pemanggilan API di `CopilotAccountsTab.tsx`:
  - `api.post('/api/accounts/${id}/cooldown', { pool })` → `api.post('/api/providers/copilot/accounts/${id}/action', { action: 'cooldown', payload: { pool } })`
  - `api.post('/api/accounts/${id}/reset')` → `api.post('/api/providers/copilot/accounts/${id}/action', { action: 'reset' })`
  - `api.delete('/api/accounts/${id}')` → `api.delete('/api/providers/copilot/accounts/${id}')`

### Phase 5: Verifikasi & Cleanup

- [x] Test semua action via curl untuk Antigravity dan Copilot dengan **provider-segmented endpoints**.
- [x] Pastikan dashboard Nougate masih bisa trigger cooldown, reset, rediscover, delete akun tanpa error.
- [x] Hapus method `updateAccountProject` dan `rediscoverAccountProject` dari `IProvider` — sudah tidak ada consumer langsung.
- [x] Verify old unified `/api/accounts/:id/*` endpoints return 404.

---

## 4. Catatan Teknis

### Kenapa Tidak Ubah Path `/oauth-callback`?
Endpoint `/oauth-callback` dan `/oauth/start` memang *by design* khusus untuk Antigravity/Google OAuth. Ini bukan kebocoran arsitektur — ini memang intentional karena flow auth Google emang butuh redirect URI fisik. Kalau nanti ada provider lain yang butuh OAuth redirect, baru kita generalize ke `/oauth/:providerId/callback`.

### Backward Compatibility
Endpoint lama bisa tetap berjalan paralel (jangan langsung dihapus) sambil frontend di-migrate satu per satu, sebelum akhirnya di-remove bersih di akhir Phase 3.
