# Pacifica Specification

Status: draft, consolidating the July 2026 design discussion.
This document is the source of truth for the `.pacifica` contract and the
framework's architecture. Servers, the build pipeline, and the client runtime
are all written against this spec.

## 1. Goals

Pacifica is a metaframework for building hybrid SSR/SPA sites that
aggressively optimize Total Blocking Time and time-to-first-interaction
(reference experience: mcmaster.com).

The core bet: **no JavaScript SSR at runtime.**

- UI is written in TypeScript/JSX with SolidJS 2.0.
- Interactive regions are explicit islands; everything outside an island is
  static HTML with Jinja2-style substitution slots.
- All SolidJS rendering happens at **build time**. The production server is a
  low-level program (target: Rust) that matches routes, concatenates named
  fragments in manifest order, executes simple substitution templates on the
  fragments that need it, and copies precomputed strings into headers. It
  makes no decisions the build could have made.
- Client-side navigation is HTMX-style partial swapping with View
  Transitions, served from static files (CDN) whenever the content class
  allows it.

Design bias, applied everywhere: **make it data, decide at build time, keep
the server dumb.**

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **page** | A leaf route component. Substitution-only static JSX. No client JS. |
| **layout** | A wrapper route component with outlets. Substitution-only. |
| **island** | A SolidJS component subtree that ships JS and hydrates. The only place client state lives. |
| **fragment** | A named build-rendered artifact: a page's output, or one piece of a layout's output (layouts are split at their outlets). The atomic unit of storage, caching, prerendering, and assembly. |
| **partial** | The per-segment unit of soft navigation: a page fragment, or a layout's fragments taken together. |
| **sequence** | The manifest-defined ordered list of fragment names for a route's full page. The unit of hard navigation. Assembled by concatenation — by the server (hard nav) and by PageRouter (soft nav, the sub-sequence below the shared layout). |
| **query** | A named, typed data dependency (`pageQuery`). The only channel between server data and UI, and the only thing that crosses the page/island boundary. |
| **inputs** | The declared request facets a query's result may vary on. Drives cache class derivation and handler constraint. |
| **class** | The derived cacheability of a fragment: `static`, `startup`, `route`, or `request`. Never authored directly. |
| **binding** | A concrete assignment of named `param`/`search` inputs, e.g. `{locale: "en"}`. The key of a prerendered artifact. |
| **prerendered artifact** | A fragment rendered at build time for a specific binding, together with its query result snapshots. |
| **envelope** | The JSON response shape shared by all query/action endpoints. |
| **PageRouter** | The client runtime for page-level soft navigation (fragment fetch + assembly, swap, View Transitions, island lifecycle). |
| **IslandRouter** | A thin wrapper around `@solidjs/router` used *inside* islands, client-side only. |

Rule of thumb stated once, used everywhere:

> Pages are substitution-only and stateless. Islands own all client state.
> Queries are the only channel between the two, and they cross the boundary
> **by name, never by value**.

## 3. Routing

### 3.1 Route tree

There is **one route tree** for the whole application, covering pages and
island sub-routes alike. It is produced either from the filesystem
(`src/routes/` by default) or supplied programmatically as a `RouteConfig`
value. Filesystem parsing is already implemented in
`packages/pacifica/src/common/routes.ts`.

Filename conventions:

| Pattern | Meaning |
|---|---|
| `index.tsx` | Index page for the enclosing segment |
| `_name.tsx` | Layout (`_`-prefixed, applies to its directory subtree) |
| `name.tsx` | Static segment `/name` |
| `[id].tsx` | Required param `/:id` |
| `[[id]].tsx` | Optional param |
| `[...rest].tsx` | Catch-all |
| `(group)` | Route group (collapsed, no URL segment) |
| `name(group).tsx` | Escaped group (segment `name`, layout lifted from `(group)`) |
| `@slot/` | Parallel route slot (Next.js-style) |
| `*name.tsx` | Fallback (`*404.tsx`, `*default.tsx`) |
| `(.)x`, `(..)x`, `(..)(..)x`, `(...)x` | Intercepting routes |
| `name.script.ts(x)` | Route-scoped client script (not a route) |
| `_.island.tsx` | **Island boundary layout** (see 3.4) |

### 3.2 Fragments and assembly

At build time, every layout's rendered output is **split at its outlet
markers into named fragments**: a layout with one outlet yields two
fragments (`_root/0.html`, `_root/1.html`); a layout with *n* outlets
(parallel routes) yields *n + 1*, and slot content interleaves in the
sequence. Pages render to a single fragment. Outlet markers exist only
inside the build; no artifact ever contains one, and there is **no byte
seeking** anywhere — assembly is lookup by name plus concatenation in
manifest order.

Consequences, which are the reasons this model was chosen over both
byte-offset stitching and full build-time composition:

- Every artifact is unique and directly inspectable; nothing is duplicated
  across routes.
- The server executes substitution **only on the fragments whose class
  requires it** and serves static fragments as raw bytes; one dynamic
  segment does not force rendering the whole page.
- The server can **stream fragments in document order** as they become
  ready — the root layout's head flushes before deeper fragments' queries
  resolve.
- Prerendering applies **per fragment per binding** (§6), so one response
  can mix prerendered and runtime-rendered fragments. This eliminates the
  binding cartesian that full-page prerendering would suffer.
- Client and server share one assembly algorithm; soft and hard navigation
  consume the same artifacts.

### 3.3 PageRouter (pages, full-stack)

PageRouter handles all navigation between page routes.

**Hard navigation** (initial load, no-JS, cross-boundary): the server
matches the URL against the manifest route tree and assembles the route's
**sequence** (§10).

**Soft navigation** (client-side): PageRouter intercepts link clicks and
popstate, matches the target URL against a client copy of the manifest route
tree, and:

1. Diffs the target route's sequence against the currently mounted one.
   Only fragments below the deepest shared layout are needed.
2. Fetches each needed fragment: `static`/`startup`-class (and
   prerender-hit) fragments as plain files from the fragments path
   (CDN-cacheable); `route`/`request`-class fragments from the origin
   (the server renders just that fragment).
3. Preloads the target's CSS/JS (from the manifest) and fires the target's
   query preloads as plain fetches, in parallel with (2).
4. Assembles the fetched sub-sequence by concatenation and swaps the changed
   outlet subtree inside `document.startViewTransition()`.
5. Disposes islands that left the DOM, hydrates islands that entered it.

Route matching is identical on client and server: walk the manifest tree,
children pre-sorted by the build (static > param > optional > catch-all), no
specificity logic at runtime.

### 3.4 Island subtrees and IslandRouter

A route subtree is **island-owned** when its layout is an island boundary
file (`_.island.tsx`). Below that node, routing is client-side via
IslandRouter (a wrapper over `@solidjs/router`).

Because island sub-routes live in the same filesystem tree, the build can:

- **Codegen the solid-router route config** for the subtree (no runtime
  introspection, no config-object requirement on the user).
- **Auto-compute `base`**: the route path of the boundary node, injected via
  the island's hydration payload. `actionBase` likewise.
- **Emit a fragment per sub-route.** Hard navigation to
  `/dashboard/settings` assembles a sequence whose island region contains
  the build-time SSR output *for the settings sub-route* (its settled or
  fallback state), with that sub-route's preloads and assets. Island
  subtrees are indistinguishable from pages for hard-nav performance.
- **Lift per-sub-route query preloads** into the manifest so the server
  streams the right data for deep hard navs.

Soft navigation *within* an island subtree is pure solid-router.

**Double-router rule:** on any link click, PageRouter matches the target URL
against the manifest. If it resolves to the **same route node currently
mounted** (i.e. an island-internal navigation), PageRouter does nothing and
lets IslandRouter handle it. Otherwise PageRouter navigates, regardless of
where the click originated.

### 3.5 Leaf islands

`<Island>` wraps a component for simple interactivity with no routing:

```tsx
<Counter client:load />        // sugar, or explicitly:
<Island><Counter /></Island>
```

The build transform (ported from solid-hybrid's `vite-plugin-island-meta`)
assigns a stable ID, records the component's import source, SSRs its content
into the enclosing fragment, and registers it in the route's client entry
for hydration. Leaf islands may use `usePageQuery` (§4.4) and solid-router
queries/actions, but not IslandRouter.

### 3.6 Intercepting and parallel routes

Parsing is implemented (slots `@name`, fallbacks `*name`, intercepts).
Runtime semantics are **deliberately sequenced last** (see §11): the
manifest reserves `slots` and `intercept` fields, and the fragment/sequence
model hosts them naturally (slots are interleaved sub-sequences), but v1
does not implement their runtime behavior.

Intended semantics (recorded for later): an intercept applies on soft
navigation only — PageRouter renders the intercepting fragment into its slot
while the URL updates; hard navigation to the same URL assembles the
non-intercepted sequence. Slots render in parallel outlets with `*default`
fallbacks resolved per-URL.

## 4. Data

### 4.1 `pageQuery`

A query is a named, typed contract with a server endpoint:

```ts
type QueryInput =
  | 'param'  | `param:${string}`   // URL route parameter(s)
  | 'search' | `search:${string}`  // query string key(s)
  | 'cookies'
  | 'headers'
  | 'request';                     // everything

const userInfo = pageQuery<UserInfo>('/user-info', {
  inputs: ['cookies'],
});
```

- `inputs` declares what the **response may vary on**. The Rust handler
  receives *only* the declared facets in its request context — the
  constraint is enforced, not documentation. (A session-varying response
  cached publicly is user A's HTML served to user B; this is the guard.)
- Bare `'param'`/`'search'` mean "any/all of them". Named forms
  (`'param:locale'`) are required for prerender coverage analysis and enable
  precise cache keying.
- `inputs: []` declares a constant: fetched once at server startup.
- **Omitted `inputs` defaults to `['request']`** — private, uncacheable.
  Cacheability is always opt-in; the failure mode of forgetting is slowness,
  never leakage.

Queries are collected into a machine-readable contract
(`.pacifica/schema.json`) consumed by the Rust side (codegen via proc
macro/build script) and by the build itself.

> @nate: What about page actions? Do we need that too? The use case would be forms outside of islands.

### 4.2 Use in pages (substitution)

In static JSX, a query result is a **typed tracking proxy** (the solid-hybrid
`tera.tsx` technique, kept deliberately: typed autocomplete is the point;
the `t`-property hack is contained behind one module and **proven against
Solid 2.0.0-beta.14** — spike §11.1a, resolved):

```tsx
function ProfilePage() {
  const user = userInfo();   // proxy — renders "{{ user_info.name }}" etc.
  return (
    <div>
      <h1>{user.name}</h1>
      <CacheControl maxAge={60} staleWhileRevalidate={3600}>
        <Stats views={user.stats.views} />
      </CacheControl>
    </div>
  );
}
```

During the build render the proxy **records every query and field path
accessed per fragment**. This recording drives: class derivation (§5),
manifest `queries` lists, preload sets, and JSON pruning (§4.4).

`<CacheControl>` is a colocated **tightening override** layered on the
derived default; it never loosens. Composition rule everywhere: **most
restrictive wins** (across a fragment's queries and CacheControl nodes, and
across a sequence's fragments for the response headers).

**Proxy mechanism notes** (from the spike, `solid-tracking-proxy-text/`;
constraints on the one module that implements the proxy):

- Solid 2 SSR still splices `{ t: string }` objects into output unescaped
  (`ssr`/`tryResolveString`/`resolveSSRNode` in `@solidjs/web`). The proxy
  must return `undefined` for `h` and `p` — Solid 2 uses those for
  async/hole-bearing templates, and a proxy answering them is misparsed as
  a complex SSR template.
- Text position emits raw `{{ … }}` via the `t` getter (Solid 2 only
  escapes `<` in text).
- Generic attributes (`href` etc.) coerce via `Symbol.toPrimitive` inside
  `ssrAttribute(name, escape(v, true))` and come out as raw `{{ … }}`; the
  proxy must implement `Symbol.toPrimitive`.
- `class={proxy}` goes through `ssrClassName`'s class-list object path
  (`Object.keys`); the proxy fakes it via `ownKeys` +
  `getOwnPropertyDescriptor`. This is the most implementation-coupled part —
  if it regresses, reserve an explicit helper for class/style and keep the
  proxy for text and generic attributes.
- `.map` emits `{% for item in … %} … {% endfor %}` as raw `{ t }` blocks.
- Access recording filters internal probes (`t`, `h`, `p`, coercion
  methods, symbols, `map`) so only real data paths are recorded.
- Page/layout build renders use `hydratable: false` — pages never hydrate,
  and hydration markers would pollute the templates. Whether an
  island-containing fragment can render in one hydratable pass, or islands
  must be SSR'd separately (hydratable) and spliced into the non-hydratable
  page render as frozen `{ t }` bytes, is an open build question (addendum
  spike pending); the two-pass splice is the known-good default.

### 4.3 Use in islands (`query`/`action` via solid-router)

Inside islands, data uses solid-router primitives wrapped by Pacifica so the
backend is a plain Rust endpoint — **no seroval, no JS server functions**.
All endpoints speak the envelope:

```jsonc
{
  "redirect":   "/photos/42",              // optional
  "data":       { },                        // return value, plain JSON
  "queries":    { "user-info": { } },       // single-flight: updated data
  "revalidate": ["photos"]                  // query keys to invalidate
}
```

The island-side wrappers translate: throw `redirect()`, `query.set()` each
entry of `queries`, `revalidate()` the listed keys. Actions set `fn.url` so
the raw `<form action>` posts to the same Rust endpoint; the handler
content-negotiates (JSON envelope for fetch, `303 See Other` for no-JS
form posts). Progressive enhancement falls out.

**Revalidation self-routes.** When an envelope names `revalidate` keys, the
client checks each key against (a) island queries in the solid-router cache
→ `revalidate()`, and (b) the current route's fragments' query lists in the
manifest → re-fetch and swap those fragments via PageRouter. Data-keyed
invalidation, uniform across the page/island boundary.

### 4.4 Crossing the boundary: `usePageQuery`

Islands never receive page data through props. They read it by name:

```tsx
function DeepInAnIsland() {
  // lens path MUST be a static string; typed via Paths<UserInfo>
  const username = usePageQuery(userInfo, 'name');
}
```

Mechanics:

- `usePageQuery` returns a **Solid 2.0 async signal**.
- At build time it resolves only if the build has data for it (prerendering,
  §6); otherwise it stays pending and the nearest suspense boundary's
  fallback is frozen into the island's SSR output.
- At runtime the server injects a pruned JSON blob (a `<script>` *before*
  the island markup in document order), so the signal resolves synchronously
  at hydration. Island SSR output is **frozen after build** — server-side
  Jinja never touches island markup. The cost: non-prerendered
  `usePageQuery` content shows its fallback between paint and hydration
  (no network wait — the data rode in with the HTML).
- The static lens path lets the build **prune the injected JSON to the union
  of accessed paths** per route, and doubles as an access manifest.

> @nate: `usePageQuery` technically cannot always return a promise because `renderToString` will render the non-fallback path iff it sees a non-awaitable value. So for pre-rendered values, they must be returned synchronously (no Promise.resolve), and for values the pre-render should skip, just return a `new Promise(() => {})`

### 4.5 Preload streaming

For hard navigations the server already computes the route's query results
(it needs them for substitution). It streams them to the client as script
chunks interleaved with the fragment stream:

```html
<script>__pacifica.push("query", "user-info", {...})</script>
```

The client bootstrap pipes pushes into the query cache (`query.set`) before
or during hydration. For prerendered fragments, the streamed data is the
**snapshot** (§6.4), never a fresh fetch. For soft navigations nothing is
streamed: PageRouter fires the manifest-listed preloads itself as plain
fetches.

## 5. Rendering classes

The class of every fragment is **derived, never authored**:

| Inputs used by the fragment's queries | Class | Rendered | Cache-Control default |
|---|---|---|---|
| (no queries at all) | `static` | at build | `public, max-age=…, immutable`-style |
| all `[]` | `startup` | at server startup | long public |
| ⊆ `{param*, search*}` | `route` | per URL at request time | `public, s-maxage=…, stale-while-revalidate=…` |
| any of `cookies`/`headers`/`request` | `request` | per request | `private, no-store` |

- Response headers for a hard nav = meet (most restrictive) of the
  sequence's fragments — but the *work* is per-fragment: static fragments
  are served as bytes, only dynamic fragments are executed (§3.2).
- `<CacheControl>` can only tighten.
- `headers` maps to `request` in v1. (A future extension may allow
  `{ header: 'accept-language' }` entries emitting `Vary`; explicitly out of
  scope now.)
- Startup rendering happens at **server startup**, not deploy time, so
  environment values differ without rebuilds; the file is a Jinja template
  either way, one rendering path.
- Exact `Cache-Control` strings and `Link` header values are **prebaked into
  the manifest** by the build. The server copies strings.

A per-segment consequence worth designing sites around: one `request`-class
segment makes the *response* private (hard navs pay for it in headers), but
soft navs still fetch the other fragments from CDN, and the server only
executes the dynamic fragment. Push dynamism into leaf fragments, or better,
into islands + query preloads, and HTML stays cacheable.

## 6. Prerendering (SSG)

Prerendering renders `route`-class content at build time for enumerated
bindings. It is **per-binding coverage of route-class fragments**, not a
fifth class.

Invariant that keeps artifact counts sane: **every fragment has exactly one
build-rendered form** (the "all non-covered queries pending" form — an
unresolved async signal always renders the same fallback, so dynamism never
forks build output), **plus one form per covered binding**. Nothing else
multiplies.

### 6.1 Enumeration

Route files export their prerender matrix; declarations **inherit down the
route subtree** and compose by cartesian product; deeper routes may extend
or override:

```tsx
// src/routes/[locale]/_layout.tsx
export const prerender = { locale: ['en', 'de', 'fr'] };

// dynamic enumerations allowed; must resolve before the render pass
export const prerender = async () => ({ id: await fetchAllProductIds() });
```

### 6.2 Data source

The build fetches query results over the **same protocol as runtime**,
against a configured `--query-origin` (staging, prod, or a fixtures stub).
The build is just another query client; no build-time coupling to Rust code.

### 6.3 Coverage and fulfillment

- A fragment is prerenderable for a binding iff the binding covers **every
  named input of every query the fragment uses** (known from proxy tracking
  + declarations). Queries with bare `'param'`/`'search'` require a fully
  bound enumeration.
- Prerendered fragments are keyed by **only the inputs they use**: a header
  reading `param:locale` is keyed `{locale}` alone, so all `/en/**` pages
  share one file. Coalescing is cache keying, not a dedup pass.
- Because assembly is per-request, prerendering composes **per fragment**:
  a hard nav to `/en/products/42` can concatenate a prerendered
  locale-keyed header (with *settled* island markup), a prerendered
  id-keyed product fragment, and a runtime-rendered session fragment.
  There is no full-page binding cartesian to pay.
- Inside islands, fulfillment granularity is the **suspense boundary**: the
  build resolves covered queries' async signals, deliberately leaves the
  rest pending, and captures the settled render — real content where
  covered, frozen fallbacks elsewhere.
- **Full-SSG mode:** for routes whose entire sequence is covered for a
  binding, the build can *optionally* also emit fully composed pages
  (`.pacifica/composed/`) — whole-page files for dumb static hosting. When
  all routes are covered, `.pacifica` deploys as a complete static site
  with no origin server (the old `renderAll` idea, now emergent). The
  origin server itself never uses composed output; it always assembles.

### 6.4 Snapshot atomicity (the consistency rule)

A prerendered fragment's markup embeds build-time data, and hydration reads
server-injected JSON. These must never disagree:

> The build writes the query result **snapshots** it used next to the
> prerendered file. When serving a prerendered fragment, the server injects
> and streams the **snapshot**, and must not re-run covered queries.
> Markup + snapshot form one atomic artifact that changes only on rebuild.

Uncovered (runtime) queries still stream fresh.

> @nate: We need a stale-while-revalidate shaped escape hatch here so that we serve the prerendered fragment+snapshot on the initial request, but allow revalidation to update the cache. Should differentiate between two modes for SSG results: 1. static meaning never changing and 2. prerendered meaning pre-cached, but revalidated on the first request. Might want to extend the `export const prerender = { ... }` API to be nested, and then include a `cache` property so the user can choose between static and prerendered. Need to think about this.

### 6.5 Layout on disk and lookup

Deterministic, index-free paths — binding serialized canonically (keys
sorted, values URL-encoded; hash only if length demands):

```
.pacifica/prerendered/
  [locale]/_layout/0.html/
    locale=en.html
    locale=en.json          # query snapshots for that render
    locale=de.html
    locale=de.json
  [locale]/products/[id].html/
    id=42&locale=en.html
    id=42&locale=en.json
```

Server lookup per fragment per request: assemble the binding key from the
fragment's declared inputs, `stat` the path. Hit → serve those bytes
(response headers still the sequence meet; prerendered artifacts change
only on rebuild). Miss → render that fragment at runtime with its derived
class. String assembly plus a stat; no index to maintain.

Build cost scales with the enumerated matrix; input-keyed coalescing keeps
shared fragments to one render each. Incremental/on-demand regeneration of
single bindings is future work; the separate `prerendered/` directory
(data-dependent, unlike the build-deterministic rest of `.pacifica`) is
what keeps that door open.

## 7. Build pipeline

Phases, in order (largely a port of the proven solid-hybrid v1 pipeline onto
the v2 route parser):

1. **Route resolution** — read the filesystem (or programmatic config) into
   `RouteConfig`; derive the manifest route tree; identify island
   boundaries; codegen IslandRouter configs.
2. **Entrypoint codegen** — a server entrypoint per layout/page/island
   sub-route (re-exports + render harness), written to `.build/server/gen`.
3. **Server build** — `vite build` (SSR, `ssrEmitAssets`) →
   `.build/server/bundle` + Vite SSR manifest.
4. **Render pass** — run each built entrypoint with the tracking proxies and
   island registry active. Produces per-segment HTML (Jinja placeholders
   inline), the per-fragment query/field access record, and the island
   registry. Prerender matrix bindings are rendered here too, with covered
   queries resolved from `--query-origin` (§6).
5. **Fragment split** — split each layout's output at its outlet markers
   into named fragments; markers exist only inside this step. Derive each
   route's sequence.
6. **Client entry codegen** — per route: hydration entries for its islands,
   IslandRouter bootstrap for island subtrees, the PageRouter runtime.
7. **Client build** — `vite build` → `.build/client/bundle` + Vite manifest.
8. **Manifest assembly** — join both Vite manifests to map every fragment
   and route to its assets (transitive chunk graph, CSS dedup,
   server-emitted CSS); derive classes; prebake `Cache-Control` and `Link`
   strings; sort route children by specificity; write `manifest.json`,
   `schema.json`, copy assets/public, write prerendered artifacts +
   snapshots; optionally emit `composed/` for fully covered routes (§6.3).

## 8. `.pacifica` directory

The `.pacifica` directory **is the server API.** Stability of this layout is
a compatibility promise.

```
.pacifica/
  manifest.json      # everything the server needs to decide anything
  schema.json        # query contracts + variable schema (Rust codegen input)
  fragments/         # named fragments: pages and split layouts (§3.2)
  prerendered/       # binding-keyed fragments + snapshots (§6.5)
  composed/          # optional: whole pages for static hosting (§6.3)
  static/            # hashed client assets (js/css/fonts…)
  public/            # user's public dir, copied verbatim
```

Fragment layout inside `fragments/` mirrors the route tree; layouts are
directories of numbered pieces:

```
fragments/
  _root/0.html
  _root/1.html
  products.html
  products/$.html
```

Fragment files are Jinja-executable; `static`-class fragments simply contain
no Jinja syntax.

## 9. `manifest.json`

Sections: `version`, `routes`, `sequences`, `fragments`, `queries`.

```jsonc
{
  "version": 1,

  "routes": {
    "segment": "/",
    "sequence": "/",                        // key into "sequences"
    "fallback": { "404": { "sequence": "/404" } },
    "children": [                           // pre-sorted by specificity
      {
        "segment": "products",
        "sequence": "/products",
        "children": [
          {
            "segment": ":id", "param": "id",
            "sequence": "/products/:id",
            "preloads": ["product"]         // queries to stream/prefetch
          }
        ]
      },
      {
        "segment": "dashboard",
        "islandRouter": { "base": "/dashboard", "actionBase": "/actions" },
        "sequence": "/dashboard",
        "children": [ /* island sub-routes: own sequences & preloads */ ]
      }
    ]
    // reserved: "slots", "intercept" (parsed today, runtime later)
  },

  "sequences": {
    "/products/:id": {
      "fragments": ["_root/0", "products/$", "_root/1"],  // concat order
      "cacheControl": "public, s-maxage=300, stale-while-revalidate=3600",
      "linkHeader": "</assets/products-D3ax.css>; rel=preload; as=style, …",
      "assets": {
        "css": ["products-D3ax.css"],
        "jsEntry": "products-9k2a.js",
        "jsImports": ["chunk-solid-Bf1x.js"]
      }
    }
  },

  "fragments": {
    "_root/0":    { "class": "startup", "queries": ["site-config"],
                    "cacheControl": "…" },
    "_root/1":    { "class": "startup", "queries": ["site-config"],
                    "cacheControl": "…" },
    "products/$": { "class": "route",   "queries": ["product"],
                    "cacheControl": "…",
                    "prerender": { "inputs": ["param:id", "param:locale"] } }
  },

  "queries": {
    "site-config": { "url": "/api/site-config", "inputs": [] },
    "product":     { "url": "/api/products/{id}",
                     "inputs": ["param:id", "param:locale"] },
    "user-info":   { "url": "/api/user-info", "inputs": ["cookies"] }
  }
}
```

Notes:

- `sequences` entries carry the response-level prebaked strings (headers,
  assets) for hard navs; `fragments` entries carry per-fragment class,
  queries, cache headers (used when a fragment is served alone for soft
  nav), and prerender coverage.
- Invariant: **every decision a server or client router must make is a
  lookup in this file.** If an implementation needs logic beyond
  tree-walking, string assembly, and template execution, the manifest is
  missing a field.

## 10. Server contract

Any conforming server (reference implementation: TypeScript; production
target: Rust — a *port*, started only once this spec stabilizes):

1. Load `manifest.json` at startup. Render `startup`-class fragments once
   (constant queries fetched at boot).
2. Per request: match segments against `routes` (children are pre-sorted;
   walk in order, extract params). Miss → nearest `fallback.404`.
3. Determine the unit: a single fragment if the request carries the
   soft-nav indicator (header `X-Pacifica-Partial` or equivalent), else the
   route's sequence.
4. For each fragment, in sequence order:
   a. Prerender check (§6.5): binding-key path hit → those bytes, and note
      its snapshot for injection/streaming.
   b. `static`/`startup` → cached bytes.
   c. Otherwise run the fragment's `queries` (context restricted to each
      query's declared `inputs`) and execute the fragment's template (Jinja
      subset; engine parity plan: minijinja in Rust / minijinja-js in the
      reference server — punted until templating DX is settled).
   Stream fragments in order as they are ready; interleave the pruned
   page-query JSON and preload script chunks (snapshots for prerendered
   fragments, fresh results otherwise).
5. Copy the sequence's prebaked `cacheControl` and `linkHeader` strings
   (fragment-level strings when serving a lone fragment). Optionally emit
   `103 Early Hints` from `linkHeader` (proven in the solid-hybrid PoC).
6. Serve `static/` and `public/` with immutable/long cache headers.
7. Query/action endpoints respond with the envelope (§4.3), content-
   negotiating JSON vs `303` for no-JS form posts.

## 11. Sequencing

1. **Spikes first** (all against SolidJS 2.0, all cheap, all load-bearing):
   a. ~~the tracking-proxy `t`-property technique on 2.0's SSR~~ —
      **RESOLVED** (2026-07-03, `solid-tracking-proxy-text/`): PASS on
      2.0.0-beta.14 with modifications, folded into §4.2 mechanism notes.
      Open addendum: whether emission survives `hydratable: true`
      (one-pass island-in-page rendering; two-pass splice works
      regardless).
   b. ~~selective async-signal resolution + settled-render capture with
      frozen suspense fallbacks (build render pass, §6.3)~~ — **RESOLVED**
      (`solid-prerender-test/`): sync value → real content, pending
      promise → `Loading` fallback, in one `renderToString` pass on
      2.0.0-beta.14. This is the source of the §4.4 note (covered values
      must return synchronously; skipped values return a never-resolving
      promise).
   c. hydration overwriting frozen fallback markup via signals (no mismatch
      breakage, acceptable flash) — **in progress**
      (`solid-hydration-overwrite-test/`).
   A failed spike changes the affected API's *mechanism*, not the
   architecture (e.g. proxy → explicit typed components).
2. Route matching completion + known parser fixes (`.script.ts` files leak
   into route segments — missing `continue` in `routes.ts`; child-overwrite
   bug in `mergeManifestRoutes`; params/catch-all/fallback matching;
   restore source↔fragment association).
3. Island system port (transform + `Island` + hydration registry **with
   disposal**, designed in from the start).
4. Build pipeline (§7) — port of v1 onto v2 routes, plus fragment split.
5. TypeScript reference server (§10) — port of the solid-hybrid HTTP/2 PoC,
   plus sequence assembly/streaming.
6. PageRouter runtime (§3.3).
7. Queries: `pageQuery`, proxy tracking, envelope wrappers, `usePageQuery`,
   preload streaming, revalidation routing.
8. Prerendering (§6).
9. Dev server (Vite middleware + `ssrLoadModule`, same manifest shapes).
10. Intercept/parallel runtime (§3.6).
11. Rust server port.

## 12. Non-goals / rejected alternatives (recorded so we stop re-deciding)

- **Byte-offset outlet interpolation** — rejected; fragile offsets coupling
  the manifest to exact rendered bytes. Fragments are split at build time
  and assembled by *name*.
- **Full build-time composition** (duplicating layout markup into one file
  per route) — superseded by fragment assembly: composition caused a
  prerender binding cartesian at the template level, forced whole-page
  Jinja execution when any segment was dynamic, duplicated artifacts, and
  blocked fragment-order streaming. Composed whole pages survive only as
  the optional `composed/` output for static hosting (§6.3).
- **seroval / JS server functions** — rejected; plain JSON envelope against
  typed contracts.
- **SSE for preload delivery** — rejected; script chunks + client fetches.
- **Island props from page data** (`$query` prop references) — rejected in
  favor of `usePageQuery`; island SSR markup stays frozen, nothing is
  prop-lowered.
- **Authored cache classes** (`site|route|request` as user-facing scopes) —
  rejected; classes are derived from query `inputs`, overrides only tighten.
- **JS SSR at request time** — the founding non-goal.
