# Dashboard frontend

React 19 + Vite 6 + TanStack Router (file-based, `basepath: '/frontend'`) +
TanStack Query + Tailwind 4 + daisyUI 5. Built to `apps/frontend/dist/` and served
by the Bun backend.

---

## Layout

```
src/
  routes/            # file-based; adding a file adds a route
    __root.tsx       #   shell + notFoundComponent
    providers/$providerId/index.tsx
    custom-providers.tsx, tokens.tsx, playground.tsx, api-keys.tsx,
    users.tsx, settings.tsx, config.tsx, logs.tsx, index.tsx
  components/
    layout/AppShell.tsx        # sidebar, breadcrumbs, active-provider list
    providers/shared/          # provider-agnostic panels — QuotaGrid, ModelRegistryTable
    providers/<id>/            # anything that genuinely knows one provider
    metrics/                   # StatTile, BarList, TrendChart
    shared/                    # CollapsibleCard, CopyButton, ConfirmModal, QuotaCard, …
    auth/                      # LoginScreen (exports AuthShell), AccountSetupScreen, AuthGate
  hooks/useQueries.ts          # every server read lives here
  lib/{api,types,format}.ts
```

**A component that names a provider belongs in `components/providers/<id>/`.**
Anything under `shared/` must be renderable for a provider it has never heard of.

---

## Server state

All reads go through `hooks/useQueries.ts`. Never `fetch` in a component.

Query keys are hierarchical so invalidation can be scoped:
`['custom-providers']`, `['custom-providers', id]`, `['custom-providers', id, 'models']`.
When you add a nested query, add its key to the matching invalidator —
`useInvalidateCustomProviders` also invalidates `['providers']`, because the sidebar
reads from the provider registry and would otherwise go stale.

Expensive lists take an `enabled` flag and are fetched only when their panel opens:

```ts
export function useCustomProviderModels(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['custom-providers', id, 'models'],
    queryFn: () => api.get<CustomProviderModel[]>(`/api/custom-providers/${id}/models`),
    enabled: !!id && enabled,
  });
}
```

---

## Render the contract, don't remap it

When the backend already defines a shape, pass the object through rather than
spreading it into props. A per-component mapping layer is a place for the UI to
disagree with the contract silently.

```tsx
<QuotaCard quota={quota} />        // quota: ProviderQuota
```

And keep the vocabulary: if the contract calls it `label`, the prop is `label`.
`QuotaCard` used to take `groupName`, which was one provider's field name leaking
into a shared component.

---

## Large lists

Some providers expose hundreds of models — OpenRouter returns ~400. Three rules:

1. **Do not build the subtree while it is collapsed.** `CollapsibleCard` takes
   `children` as a *function*, so nothing renders until it opens:
   ```tsx
   <CollapsibleCard title="MODELS" badge={count} onOpen={() => setOpen(true)}>
     {() => <ModelEditor models={models ?? []} isLoading={loading} />}
   </CollapsibleCard>
   ```
2. **Actions go above the list, not below it.** A save button under 400 rows is
   several screens down.
3. **Scroll the list inside its own box** (`max-h-[28rem] overflow-auto` +
   `table-pin-rows`) so the toolbar stays put, and offer a filter past ~8 rows.

The detail endpoint should return a **count**, not the array — `describeProvider`
returns `modelCount` and the models are a separate lazy request.

---

## Layout and theming

- **Mobile first.** Every flex row that can wrap gets `flex-wrap` and `min-w-0`;
  every truncatable text gets `truncate`. Toggle rows stack as
  `<input class="shrink-0 mt-0.5"> + <span class="min-w-0">label + description</span>`
  — a description beside an unconstrained toggle overlaps on narrow screens.
- **Wide content scrolls inside itself.** Tables and code blocks get their own
  `overflow-x-auto`; the page body never scrolls horizontally.
- **Never set a form control below 16px on mobile.** iOS Safari zooms the viewport
  when a focused control computes under 16px and will not zoom back out. A global
  block in `styles/main.css` pins every input, select and textarea to 16px below the
  `sm` breakpoint, and lifts labels, buttons and table text to match. Use `input-sm`
  and `text-xs` freely — the override handles it — but do not add a `max-width` media
  query that undoes it, and do not "fix" auto-zoom with `maximum-scale=1`, which
  disables pinch-zoom for everyone.
- **Use daisyUI semantic tokens** (`base-100/200/300`, `primary`, `warning`,
  `base-content/50`) — never a hard-coded hex. Both themes then work for free.
- **Charts:** load the `dataviz` skill before writing chart code. Existing pieces:
  `StatTile` (headline number), `BarList` (ranked magnitude, single hue, direct
  labels), `TrendChart`.
- **Never encode meaning in colour alone.** The "unpriced" state is a badge with a
  word in it, not a shade.

---

## Caching of the bundle itself

`serveFrontendAsset` in `router/admin.ts` sets `Cache-Control: no-store` for
`index.html` and `immutable` for fingerprinted `/assets/*`. Without that, a browser
holds a stale `index.html` pointing at a deleted bundle and new routes 404 — that
was the cause of a "route doesn't exist" report that was really a caching bug.
`__root.tsx` also defines a `notFoundComponent` so a genuine miss is legible.

---

## Verify

```bash
cd apps/frontend
./node_modules/.bin/tsc -b        # type errors vite build will not catch
npx vite build
git checkout tsconfig.tsbuildinfo # tracked, churns on every typecheck
```

`vite build` alone is not enough: esbuild strips types without checking them.
