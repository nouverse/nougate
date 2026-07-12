# Frontend Modular Implementation Plan — Nougate

> **Dokumen ini adalah panduan lengkap untuk rombak total frontend Nougate.**
> Tech stack: **React + Vite + TanStack Router + TailwindCSS 4 + daisyUI 5**. Mobile-first. Provider-isolated UI.

---

## Status Quo (Apa yang Ada Sekarang)

### Struktur File

```
src/frontend/
├── index.html              # Entry — loads components via fetch()
├── components/
│   ├── header.html         # Top bar (strategy, theme, add account)
│   ├── main.html           # Accounts table + model family grid
│   └── config-modal.html   # Settings modal (JSON editor)
├── js/
│   ├── app.js              # 42KB monolith — semua logic di sini
│   └── tailwind-config.js  # Custom Tailwind theme
└── css/
    └── styles.css          # Minimal custom CSS
```

### Masalah

1. **Monolith `app.js` (42KB)** — Satu file JavaScript, tidak modular, tidak testable
2. **Flat layout** — Semua (accounts, quota grid, logs, config) di 1 halaman tanpa navigasi
3. **Provider-unaware** — UI tidak tahu konsep "provider". Semua account ditampilkan rata tanpa grouping
4. **Model naming lama** — Masih referensi `antigravity-gemini-*`, bukan `antigravity:gemini-*`
5. **Add Account global** — Button "ADD ACCOUNT" langsung ke `/oauth/start`, tidak tahu provider mana
6. **Config modal global** — Edit JSON config global, tidak ada per-provider config editor
7. **Not truly mobile-friendly** — Responsive breakpoints ada tapi layout belum optimal di mobile (table overflow, header dense)
8. **CDN Tailwind** — Pakai `cdn.tailwindcss.com` (dev-only build), tidak production-ready

---

## Target: Arsitektur Frontend Baru

### Prinsip Desain

1. **Provider-First Navigation**: Sidebar/drawer dengan navigasi ke setiap provider
2. **Mobile-First**: Semua layout dimulai dari mobile, breakpoint untuk desktop
3. **Component-Based**: React components untuk reusability dan testability
4. **daisyUI Components**: Leverage component library untuk consistency
5. **Provider Isolation di UI**: Setiap provider punya halaman sendiri — accounts, models, config
6. **Real-time tetap**: SSE-based live updates via custom React hooks
7. **Type-safe routing**: TanStack Router untuk full typesafe routes

### Tech Stack

| Layer | Sekarang | Baru |
|---|---|---|
| UI Library | Vanilla JS (raw DOM) | **React 19** |
| Build Tool | None (CDN) | **Vite 6** |
| Routing | None (single page) | **TanStack Router** (file-based, typesafe) |
| CSS Framework | Tailwind CDN | **TailwindCSS 4 + daisyUI 5** |
| State | Global vars | **React state + context** (or Zustand if needed) |
| HTTP | Raw fetch | **TanStack Query** (caching, refetching) |
| SSE | Raw EventSource | **Custom React hook** (`useSSE`) |

### Frontend sebagai Sub-Project

Frontend diinisialisasi sebagai Vite React project **di dalam** `src/frontend/`:

```
nougate/
├── src/
│   ├── server.ts            # Backend
│   ├── frontend/            # ← Vite React sub-project
│   │   ├── package.json     # Frontend-specific deps (React, Vite, TanStack, daisyUI)
│   │   ├── vite.config.ts
│   │   ├── tailwind.config.ts
│   │   ├── tsconfig.json
│   │   ├── index.html        # Vite entry
│   │   ├── src/
│   │   │   ├── main.tsx       # React entry
│   │   │   └── ...
│   │   └── dist/              # Build output → served by Bun
│   └── ...
├── package.json              # Root (backend)
└── ...
```

> [!IMPORTANT]
> Backend (`src/server.ts`) serves `src/frontend/dist/` sebagai static files.
> Development: `cd src/frontend && npm run dev` (Vite dev server dengan proxy ke backend :3000).
> Production: `cd src/frontend && npm run build` → output di `dist/`, served by Bun.

### Struktur File Target

```
src/frontend/
├── package.json
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── index.html                          # Vite HTML entry
├── src/
│   ├── main.tsx                        # React entry + router
│   ├── App.tsx                         # App shell (sidebar + outlet)
│   ├── styles/
│   │   └── main.css                    # Tailwind directives + custom
│   │
│   ├── routes/
│   │   ├── __root.tsx                  # TanStack root layout (shell)
│   │   ├── index.tsx                   # / → Overview dashboard
│   │   ├── config.tsx                  # /config → Global config editor
│   │   ├── logs.tsx                    # /logs → Full-page log viewer
│   │   └── providers/
│   │       ├── index.tsx               # /providers → Provider list
│   │       └── $providerId/
│   │           ├── index.tsx           # /providers/$providerId → Provider dashboard
│   │           ├── accounts.tsx        # /providers/$providerId/accounts
│   │           ├── models.tsx          # /providers/$providerId/models
│   │           └── config.tsx          # /providers/$providerId/config
│   │
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx             # Desktop sidebar navigation
│   │   │   ├── MobileDrawer.tsx        # Mobile drawer (daisyUI drawer)
│   │   │   ├── Header.tsx              # Top bar (breadcrumbs, actions)
│   │   │   └── AppShell.tsx            # Compose sidebar + header + outlet
│   │   ├── shared/
│   │   │   ├── HealthBadge.tsx         # Health score badge
│   │   │   ├── QuotaCard.tsx           # Model family quota card
│   │   │   ├── LogViewer.tsx           # Console output (scrollable, filterable)
│   │   │   ├── JsonEditor.tsx          # JSON config editor (textarea + validation)
│   │   │   ├── ConfirmModal.tsx        # daisyUI modal for destructive actions
│   │   │   └── EmptyState.tsx          # Empty state placeholder
│   │   └── providers/
│   │       └── antigravity/
│   │           ├── AccountsTable.tsx   # Desktop table
│   │           ├── AccountCard.tsx     # Mobile card
│   │           ├── AccountDetail.tsx   # Expanded account (scores, cooldowns, quota)
│   │           ├── QuotaGrid.tsx       # Model family availability grid
│   │           ├── ModelRegistryTable.tsx # Model specs table
│   │           └── ConfigForm.tsx      # Provider config form
│   │
│   ├── hooks/
│   │   ├── useSSE.ts                   # SSE connection + reconnect
│   │   ├── useProviders.ts             # TanStack Query: GET /api/providers
│   │   ├── useProviderDetail.ts        # TanStack Query: GET /api/providers/:id
│   │   ├── useAccounts.ts             # TanStack Query: GET /api/providers/:id/accounts
│   │   ├── useModels.ts               # TanStack Query: GET /api/providers/:id/models
│   │   ├── useConfig.ts               # TanStack Query: GET /api/config + mutations
│   │   └── useTheme.ts                # Theme toggle (localStorage persist)
│   │
│   ├── lib/
│   │   ├── api.ts                      # Typed fetch wrapper
│   │   └── types.ts                    # Shared TypeScript types (API responses)
│   │
│   └── assets/
│       └── logo.svg                    # Nougate logo (optional)
│
└── dist/                               # Build output (gitignored)
```

---

## Layout & Navigation

### Desktop (≥ 1024px)

```
┌─────────────────────────────────────────────────────────────┐
│ ┌──────────┐ ┌──────────────────────────────────────────┐   │
│ │ SIDEBAR   │ │ CONTENT (TanStack Router <Outlet />)     │   │
│ │           │ │                                          │   │
│ │ ☰ Nougate │ │  Breadcrumb: Providers > Antigravity     │   │
│ │           │ │                                          │   │
│ │ Overview  │ │  ┌──────────┐ ┌──────────┐ ┌──────────┐ │   │
│ │           │ │  │ Quota    │ │ Quota    │ │ Quota    │ │   │
│ │ Providers │ │  │ Card 1   │ │ Card 2   │ │ Card 3   │ │   │
│ │  ▸ Anti.. │ │  └──────────┘ └──────────┘ └──────────┘ │   │
│ │  ▸ Codex  │ │                                          │   │
│ │           │ │  Accounts Table                          │   │
│ │ Config    │ │  ┌──────────────────────────────────────┐ │   │
│ │ Logs      │ │  │ Email | Health | Last Active | ···   │ │   │
│ │           │ │  │─────────────────────────────────────│ │   │
│ │           │ │  │ gading@... | 85% | 2m ago    | ··· │ │   │
│ └──────────┘ │  └──────────────────────────────────────┘ │   │
│              └──────────────────────────────────────────┘    │
│ ┌───────────────────────────────────────────────────────┐   │
│ │ CONSOLE OUTPUT (collapsible, resizable)                │   │
│ └───────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Mobile (< 1024px)

```
┌───────────────────────┐
│ ☰  Nougate     ⚙️  +  │  ← Hamburger, settings, add
├───────────────────────┤
│ Providers > Antigravity│  ← Breadcrumb
├───────────────────────┤
│ ┌───────────────────┐ │
│ │ Quota Cards       │ │  ← Horizontal scroll
│ │ (swipeable)       │ │
│ └───────────────────┘ │
│                       │
│ ┌───────────────────┐ │
│ │ Account Card 1    │ │  ← Cards, not table
│ │ gading@gmail.com  │ │
│ │ Health: 85%       │ │
│ │ Last: 2m ago      │ │
│ └───────────────────┘ │
│ ┌───────────────────┐ │
│ │ Account Card 2    │ │
│ └───────────────────┘ │
│                       │
│ 📋 Console (bottom)   │
└───────────────────────┘
```

**Key mobile differences:**
- Sidebar → Drawer (slide-in via hamburger, daisyUI `drawer`)
- Accounts table → Card layout (stacked)
- Quota grid → Horizontal scroll carousel
- Console → Bottom sheet / collapsible footer

---

## Routes (TanStack Router)

### File-Based Route Tree

```
routes/
├── __root.tsx              → Root layout (AppShell)
├── index.tsx               → /                          Overview dashboard
├── config.tsx              → /config                    Global config editor
├── logs.tsx                → /logs                      Full-page log viewer
└── providers/
    ├── index.tsx           → /providers                 Provider list
    └── $providerId/
        ├── index.tsx       → /providers/$providerId     Provider dashboard (tabs)
        ├── accounts.tsx    → /providers/$providerId/accounts
        ├── models.tsx      → /providers/$providerId/models
        └── config.tsx      → /providers/$providerId/config
```

### Route Definitions

```typescript
// routes/__root.tsx
import { createRootRoute, Outlet } from '@tanstack/react-router';
import { AppShell } from '../components/layout/AppShell';

export const Route = createRootRoute({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});

// routes/providers/$providerId/index.tsx
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/providers/$providerId/')({
  component: ProviderDashboard,
  loader: ({ params }) => fetchProviderDetail(params.providerId),
});

function ProviderDashboard() {
  const { providerId } = Route.useParams();
  const data = Route.useLoaderData();
  // tabs: Overview | Accounts | Models | Config
  return <ProviderLayout providerId={providerId} data={data} />;
}
```

---

## Data Layer

### TanStack Query Hooks

```typescript
// hooks/useProviders.ts
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export function useProviders() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get<Provider[]>('/api/providers'),
    staleTime: 30_000,
  });
}

// hooks/useAccounts.ts
export function useAccounts(providerId: string) {
  return useQuery({
    queryKey: ['providers', providerId, 'accounts'],
    queryFn: () => api.get<Account[]>(`/api/providers/${providerId}/accounts`),
    refetchInterval: 10_000, // auto-refresh setiap 10s
  });
}

// hooks/useSSE.ts — realtime updates
export function useSSE(onEvent: (event: SSEEvent) => void) {
  useEffect(() => {
    const source = new EventSource('/api/sse');
    source.onmessage = (e) => onEvent(JSON.parse(e.data));
    source.onerror = () => {
      source.close();
      setTimeout(() => /* reconnect */, 3000);
    };
    return () => source.close();
  }, []);
}
```

### SSE Integration with TanStack Query

```typescript
// Di App.tsx atau __root.tsx
function SSEProvider({ children }) {
  const queryClient = useQueryClient();

  useSSE((event) => {
    switch (event.type) {
      case 'account_update':
        // Invalidate accounts query → auto-refetch
        queryClient.invalidateQueries({ queryKey: ['providers', event.providerId, 'accounts'] });
        break;
      case 'log':
        // Append to log store (tidak perlu query, langsung state)
        useLogStore.getState().addLog(event.data);
        break;
    }
  });

  return <>{children}</>;
}
```

---

## daisyUI Component Mapping

| UI Element | daisyUI Component | Notes |
|---|---|---|
| Sidebar | `menu` + `drawer` | Responsive drawer on mobile |
| Quota cards | `card` + `stats` | With `progress` bar for availability |
| Accounts table | `table` (desktop) | Responsive: hidden on mobile |
| Account cards | `card` (mobile) | Visible only < lg |
| Health badge | `badge` | Color-coded: green/yellow/red |
| Config editor | `textarea` + `btn` | With JSON validation |
| Feature toggles | `toggle` | For boolean features |
| Toast | `toast` + `alert` | Success/error feedback |
| Strategy selector | `select` | In header/sidebar |
| Add account | `btn btn-primary` | Per-provider |
| Log viewer | Custom + `mockup-code` | Monospace, color-coded levels |
| Tabs | `tabs` + `tab` | Within provider pages |
| Breadcrumbs | `breadcrumbs` | From TanStack Router context |
| Theme toggle | `theme-controller` | daisyUI built-in, swap component |
| Modal | `modal` | For confirmations (delete account, etc.) |
| Loading | `loading` + `skeleton` | Skeleton + spinners |
| Navbar (mobile) | `navbar` | Top bar for mobile |

---

## Theme

### daisyUI Theme Config

```typescript
// tailwind.config.ts
import daisyui from 'daisyui';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  plugins: [daisyui],
  daisyui: {
    themes: [
      {
        nougate: {
          "primary": "#10b981",       // emerald-500 (brand)
          "primary-content": "#ffffff",
          "secondary": "#6366f1",     // indigo-500
          "accent": "#f59e0b",        // amber-500
          "neutral": "#18181b",       // zinc-900
          "base-100": "#09090b",      // zinc-950 (dark bg)
          "base-200": "#18181b",      // zinc-900
          "base-300": "#27272a",      // zinc-800
          "base-content": "#e4e4e7",  // zinc-200
          "info": "#3b82f6",
          "success": "#10b981",
          "warning": "#f59e0b",
          "error": "#ef4444",
        },
        "nougate-light": {
          "primary": "#059669",       // emerald-600
          "primary-content": "#ffffff",
          "secondary": "#4f46e5",
          "accent": "#d97706",
          "neutral": "#f4f4f5",
          "base-100": "#ffffff",
          "base-200": "#f4f4f5",
          "base-300": "#e4e4e7",
          "base-content": "#18181b",
          "info": "#2563eb",
          "success": "#059669",
          "warning": "#d97706",
          "error": "#dc2626",
        }
      }
    ],
    darkTheme: "nougate",
  }
};
```

---

## Vite Config

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';

export default defineConfig({
  plugins: [
    TanStackRouterVite(),    // Auto-generate route tree
    react(),
  ],
  base: '/frontend/',        // Serve under /frontend/ path
  build: {
    outDir: 'dist',
    emptyDirFirst: true,
  },
  server: {
    port: 5173,
    proxy: {
      // Proxy API calls to backend during dev
      '/api': 'http://localhost:3000',
      '/openai': 'http://localhost:3000',
      '/anthropic': 'http://localhost:3000',
      '/oauth': 'http://localhost:3000',
    },
  },
});
```

---

## Checklist — Frontend Rombak

### Phase F1: Project Setup

- [ ] Initialize Vite React project di `src/frontend/`:
  ```bash
  cd src/frontend
  npm create vite@latest . -- --template react-ts
  ```
- [ ] Install dependencies:
  ```bash
  npm install @tanstack/react-router @tanstack/react-query
  npm install -D @tanstack/router-plugin tailwindcss @tailwindcss/vite daisyui
  ```
- [ ] Buat `tailwind.config.ts` dengan tema nougate (dark/light)
- [ ] Buat `vite.config.ts` dengan TanStack Router plugin + React plugin + proxy config
- [ ] Buat `src/styles/main.css` dengan Tailwind directives
- [ ] Buat `src/main.tsx` — React entry, router provider, query provider
- [ ] Buat `src/routes/__root.tsx` — root layout (placeholder shell)
- [ ] Buat `src/routes/index.tsx` — overview placeholder
- [ ] Update root `package.json`:
  - `"build:frontend": "cd src/frontend && npm run build"`
  - `"dev:frontend": "cd src/frontend && npm run dev"`
- [ ] Update `src/server.ts` — serve `src/frontend/dist/` sebagai static files under `/frontend/`
- [ ] **Verifikasi**:
  - `cd src/frontend && npm run dev` → Vite dev server di :5173, proxy ke :3000
  - `cd src/frontend && npm run build` → output di `dist/`
  - `GET /frontend/` dari backend → serves built app

### Phase F2: Layout Components

- [ ] Buat `src/components/layout/Sidebar.tsx`:
  - daisyUI `menu` component
  - Navigation items: Overview, Providers (children dari API), Config, Logs
  - Active route highlighting via TanStack Router `Link`
  - Collapsible provider sub-menu
- [ ] Buat `src/components/layout/MobileDrawer.tsx`:
  - daisyUI `drawer` wrapping sidebar
  - Hamburger toggle di header
  - Overlay + close on navigation
- [ ] Buat `src/components/layout/Header.tsx`:
  - Mobile: hamburger + "Nougate" + actions (theme, add)
  - Desktop: breadcrumbs (dari router context) + strategy selector + theme toggle
- [ ] Buat `src/components/layout/AppShell.tsx`:
  - Compose: Drawer (mobile) | Sidebar (desktop) + Header + `<Outlet />`
  - Responsive: `lg:` breakpoint untuk sidebar show/hide
- [ ] **Verifikasi**: navigate antar routes, drawer buka/tutup, responsive layout

### Phase F3: Data Layer & Shared Components

- [ ] Buat `src/lib/api.ts` — typed fetch wrapper:
  - `api.get<T>(url)`, `api.post<T>(url, body)`, `api.delete(url)`
  - Base URL handling, error parsing
- [ ] Buat `src/lib/types.ts` — TypeScript types untuk API responses:
  - `Provider`, `Account`, `ModelSpec`, `ProxyConfig`, `SSEEvent`
- [ ] Buat `src/hooks/useSSE.ts` — SSE connection hook:
  - Auto-reconnect on error
  - Event dispatch ke TanStack Query invalidation
- [ ] Buat `src/hooks/useProviders.ts` — TanStack Query hook
- [ ] Buat `src/hooks/useAccounts.ts` — TanStack Query hook (scoped ke provider)
- [ ] Buat `src/hooks/useModels.ts` — TanStack Query hook
- [ ] Buat `src/hooks/useConfig.ts` — Query + mutation hook
- [ ] Buat `src/hooks/useTheme.ts` — theme toggle (localStorage + `data-theme` attr)
- [ ] Buat shared components:
  - [ ] `HealthBadge.tsx` — color-coded badge (`badge-success`, `badge-warning`, `badge-error`)
  - [ ] `QuotaCard.tsx` — daisyUI `card` + `stats` + `progress`
  - [ ] `LogViewer.tsx` — monospace log panel, level filter, auto-scroll
  - [ ] `JsonEditor.tsx` — `textarea` + JSON validation + save button
  - [ ] `ConfirmModal.tsx` — daisyUI `modal` for destructive actions
  - [ ] `EmptyState.tsx` — placeholder untuk empty data
- [ ] **Verifikasi**: components render, hooks fetch data, SSE connects

### Phase F4: Overview & Logs Pages

- [ ] Buat `src/routes/index.tsx` — Overview Dashboard:
  - Provider summary cards (account count, health, model count)
  - Recent activity feed (dari SSE)
  - Quick links ke provider pages
  - daisyUI `stats` component untuk aggregated numbers
- [ ] Buat `src/routes/logs.tsx` — Full-page Log Viewer:
  - `LogViewer` component, full-height
  - Level filters (tabs: All, Info, Warn, Error)
  - Search within logs
  - Auto-scroll toggle
  - Clear logs button
- [ ] **Verifikasi**: `/` shows overview with data, `/logs` shows live SSE logs

### Phase F5: Provider Pages (Antigravity)

- [ ] Buat `src/routes/providers/index.tsx` — Provider list:
  - Grid of provider cards
  - Each card: name, account count, health summary, model count
  - Click → navigate to `/providers/$providerId`
- [ ] Buat `src/routes/providers/$providerId/index.tsx` — Provider Dashboard:
  - daisyUI `tabs`: Overview | Accounts | Models | Config
  - Overview tab: QuotaGrid + recent account activity
- [ ] Buat provider-specific components:
  - [ ] `QuotaGrid.tsx` — model family quota cards grid
  - [ ] `AccountsTable.tsx` — desktop table (daisyUI `table`):
    - Columns: Email, Health, Last Active, Project ID, Actions
    - Expandable rows: model scores, cooldowns, capabilities, quota details
    - Actions: refresh token, reset health, delete (with `ConfirmModal`)
  - [ ] `AccountCard.tsx` — mobile card layout (same data, stacked)
  - [ ] `AccountDetail.tsx` — expanded account info (shared between table row and card)
  - [ ] `ModelRegistryTable.tsx` — sortable/filterable model list:
    - Columns: Model ID, Pool, Thinking, Timeout, Upstream Model
    - Search input
  - [ ] `ConfigForm.tsx` — provider config editor:
    - Known fields: daisyUI form controls (toggles, inputs, selects)
    - Advanced: raw JSON editor fallback
    - Save button → mutation via TanStack Query
- [ ] Buat `src/routes/providers/$providerId/accounts.tsx` — accounts full page
- [ ] Buat `src/routes/providers/$providerId/models.tsx` — models full page
- [ ] Buat `src/routes/providers/$providerId/config.tsx` — config full page
- [ ] **Add Account flow**:
  - Button in accounts page
  - Antigravity: `window.location.href = '/oauth/start'`
  - After OAuth callback: SSE event → TanStack Query invalidation → account appears
- [ ] **Verifikasi**:
  - `/providers` → provider list
  - `/providers/antigravity` → dashboard with tabs
  - `/providers/antigravity/accounts` → accounts table/cards
  - `/providers/antigravity/models` → model registry
  - `/providers/antigravity/config` → config editor, save works
  - Add account → OAuth flow → account appears in list

### Phase F6: Global Config & Polish

- [ ] Buat `src/routes/config.tsx` — Global Config Editor:
  - Form controls for known fields (rotation, scoring, retry, logging)
  - Raw JSON editor for advanced
  - Save → `POST /api/config`
- [ ] Theme switching:
  - daisyUI `theme-controller` (swap component)
  - `useTheme()` hook → `data-theme` on `<html>`
  - Persist in localStorage
  - Options: Dark (nougate), Light (nougate-light), System
- [ ] Mobile polish:
  - Test semua page di viewport 375px (iPhone SE)
  - Drawer swipe close
  - Bottom safe area padding
  - Touch-friendly button sizes (min 44px)
- [ ] Performance:
  - Route-based code splitting (TanStack Router lazy routes)
  - React.memo untuk heavy components (LogViewer, AccountsTable)
  - Debounce SSE updates
  - Virtual scroll untuk log viewer jika > 500 entries (react-virtuoso)
- [ ] Error handling:
  - TanStack Query error boundaries
  - Toast notifications on mutation errors
  - Offline indicator
- [ ] **Verifikasi FINAL**:
  - Semua routes navigable (browser back/forward works)
  - Mobile drawer berfungsi
  - Add account flow end-to-end
  - Config save/load (global + per-provider)
  - SSE live updates (accounts, logs)
  - Theme toggle persists across refresh
  - `npm run build` → clean production output
  - Lighthouse: Performance ≥ 90, Accessibility ≥ 90

### Phase F7: Cleanup

- [ ] **Hapus** seluruh folder `src/frontend/` lama:
  - `src/frontend/components/` (header.html, main.html, config-modal.html)
  - `src/frontend/js/` (app.js, tailwind-config.js)
  - `src/frontend/css/` (styles.css)
  - `src/frontend/index.html` (old entry)
- [ ] Update `.gitignore`:
  - `src/frontend/dist/`
  - `src/frontend/node_modules/`
  - `src/frontend/src/routeTree.gen.ts` (TanStack Router generated)
- [ ] Update `Dockerfile`:
  - `cd src/frontend && npm install && npm run build`
  - Copy `src/frontend/dist/` ke runtime image
- [ ] Update `README.md` — screenshot baru
- [ ] **Hapus** `screenshots/screenshot.png` — replace dengan screenshot baru

---

## Backend API Changes Needed

> [!IMPORTANT]
> Endpoint baru di bawah ini perlu ditambahkan di `src/router/admin.ts` sebelum Phase F5.

```typescript
// src/router/admin.ts — tambahan routes

// List registered providers
GET /api/providers
// → [{ id: "antigravity", displayName: "Antigravity", accountCount: 2, modelCount: 15 }]

// Provider detail
GET /api/providers/:id
// → { id, displayName, config, models: [...], accounts: [...] }

// Provider config CRUD
GET  /api/providers/:id/config
POST /api/providers/:id/config

// Provider models (from registry)
GET /api/providers/:id/models
// → [{ modelId, pool, isThinking, thinkingMode, maxOutputTokens, timeoutMs, upstreamModelId }]

// Provider accounts (scoped)
GET  /api/providers/:id/accounts
POST /api/providers/:id/accounts/add   // → returns redirect URL or triggers auth flow
```

---

## Aturan untuk Agent

1. **Mobile-first**: Selalu build mobile layout dulu, tambahkan desktop breakpoints setelahnya (`lg:`)
2. **daisyUI-first**: Gunakan daisyUI components sebelum bikin custom. Custom hanya jika daisyUI tidak cover
3. **TanStack Router file-based**: Jangan manual define routes — gunakan file-based routing dengan plugin
4. **TanStack Query untuk semua API calls**: Jangan raw `fetch` di komponen — semua lewat `useQuery`/`useMutation`
5. **Provider-agnostic layout**: Shell dan navigation tidak hardcode "antigravity". Semua didapat dari `/api/providers`
6. **SSE invalidates Query**: SSE events trigger `queryClient.invalidateQueries()`, bukan manual state updates
7. **Dark theme default**: `nougate` (dark) sebagai default, `nougate-light` optional
8. **Test on 375px**: Minimum viewport width support
9. **TypeScript strict**: Semua components dan hooks fully typed, no `any`
10. **No prop drilling**: Gunakan TanStack Router loader data + Query hooks, bukan pass props 5 levels deep
