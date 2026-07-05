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

Pacifica is a fusion of two templating systems: **JSX at build time**
(arbitrary code, full expressiveness — load whatever you want, render it
programmatically) and **Jinja at request time** (dumb substitution of
prebaked or query-derived values). Every "where does dynamic X go?"
question resolves to one of the two.

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
| **class** | The derived cacheability of a fragment: `static`, `route`, or `request`. Never authored directly. |
| **binding** | A concrete assignment of route **params** (only params — §6), e.g. `{locale: "en"}`. The key of a prerendered artifact. |
| **prerendered artifact** | A fragment rendered at build time for a specific binding, with its query pushes inlined. Final bytes under `html/`. |
| **push** | An inline `<script>` carrying one query result, embedded in a fragment's bytes by whoever rendered the fragment (§4.5). |
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
| `(name).tsx` | Named index alias — an index page with a meaningful filename |
| `_name.tsx` | Layout (`_`-prefixed, applies to its directory subtree) |
| `name.tsx` | Static segment `/name` |
| `[id].tsx` | Required param |
| `[[id]].tsx` | Optional param |
| `[...rest].tsx` | Catch-all |
| `(group)` | Route group (collapsed, no URL segment) |
| `name(group).tsx` | Escaped group (segment `name`, layout lifted from `(group)`) |
| `@slot/` | Parallel route slot (Next.js-style) |
| `!name.tsx` | Fallback (`!404.tsx`, `!default.tsx`) — `!` because `*` is not Windows-legal in filenames |
| `(.)x`, `(..)x`, `(..)(..)x`, `(...)x` | Intercepting routes |
| `name.script.ts(x)` | Route-scoped client script (not a route) |
| `_name.island.tsx` | **Island boundary layout** (see 3.4) |
| `name.island.tsx` | **Leaf island page** (see 3.5) |

`.island` is a **type suffix** on the same axis as `.script`: it says what
kind of module the file is, orthogonal to what the route segment is named.
The `_` prefix remains the layout/page discriminator, so `_name.island.tsx`
is an island *boundary layout* and `name.island.tsx` (or `index.island.tsx`)
is a *leaf island page*. Island-ness is communicated **only** through
filenames — route scanning never reads file contents (no marker exports),
so the route tree is derivable by any tool (dev server rescans, the build,
the Rust server's manifest consumers) without JS module semantics.

Suffix errors (parse-time):

- `.island` anywhere below an existing island boundary — there is no second
  hydration root inside a running island; this covers both nested boundary
  layouts and island pages under a boundary.
- `.island` combined with `.script`.

**Index mapping.** A directory's index page — `index.tsx`, or exactly one
parenthesized alias file `(name).tsx` — is the page for the enclosing
segment's own path. Parens on a *directory* form a route group; parens on
a *file* form an index alias. Neither contributes a URL segment. More than
one index in a directory (any combination of `index.tsx` and aliases) is a
parse error. The alias name carries into fragment space: `(home).tsx` →
fragment `(home)` (§8.1) — the meaningful name is the point.

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

**The document preamble.** The root layout is additionally split at the
body-open boundary: `_root/doc` (doctype, `<html>`, the full `<head>`,
and the `<body>` open tag) precedes `_root/0` in every sequence. The
preamble is where the build injects the queue stub (§4.5), where the
announce lands (§4.5), and where per-route head content lives: the root
layout receives `props.assets` — a substitution value using the same
proxy → placeholder machinery as queries (§4.2), resolved by the build
from the manifest instead of an endpoint — and splices it into its
`<head>` JSX. The substituted string is the sequence's prebaked asset
tags (`assetsHtml`, §9); the origin substitutes it per request (a string
copy), composed-page derivation bakes it. The preamble is never fetched
on soft nav (it is always above the shared layout) and is never
prerendered standalone (its substitution is sequence-scoped, not
binding-scoped).

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
2. Fetches each needed fragment: `static`-class fragments and prerender
   hits as plain files from `html/_pacifica/` (CDN-served, §8);
   `route`/`request`-class fragments from the origin (the server renders
   just that fragment, pushes inlined).
3. Preloads the target's CSS/JS (from the manifest), in parallel with (2).
4. Assembles the fetched sub-sequence by concatenation and swaps the changed
   outlet subtree inside `document.startViewTransition()`. Scripts inside
   fetched fragment bytes (pushes, island boundary-state scripts) are inert
   when inserted via `innerHTML`; PageRouter **re-creates each script
   element** so they execute (§4.5).
5. Disposes islands that left the DOM, hydrates islands that entered it.
6. Entering islands' `usePageQuery` calls resolve per the resolution rule
   (§4.5). No announce is needed on soft nav: PageRouter chose each
   fragment's source itself in (2), and the expected-push set is the
   union of the fetched fragments' manifest `pushes` (§4.5, §9) — valid
   for origin-rendered, prerendered, and static bytes alike. Anything an
   island reads outside that set is fetched by the query cache on first
   read.

(PageRouter is client-only, per §2. The server side of navigation is just
the §10 contract; nothing here runs on the server.)

Route matching is identical on client and server: walk the manifest tree,
children pre-sorted by the build (static > param > optional > catch-all), no
specificity logic at runtime.

### 3.4 Island subtrees and IslandRouter

A route subtree is **island-owned** when its layout carries the `.island`
type suffix (`_name.island.tsx`). Below that node, routing is client-side
via IslandRouter (a wrapper over `@solidjs/router`). The boundary file *is*
that node's layout — a directory cannot have both a static layout and an
island boundary. Static chrome around an island region is expressed by
nesting: a static `_shell.tsx` in the parent directory, the boundary layout
one level down. Sub-route files below the boundary stay completely ordinary
(`index.tsx`, `settings.tsx`, `[id].tsx`); their island-ness is inherited
from the nearest boundary ancestor, and nested layouts below it become
nested solid-router layouts via codegen, no special naming. The DX story:
want client-side routing under `/dashboard`? Rename `_dashboard.tsx` to
`_dashboard.island.tsx`.

Because island sub-routes live in the same filesystem tree, the build can:

- **Codegen the solid-router route config** for the subtree (no runtime
  introspection, no config-object requirement on the user).
- **Auto-compute `base`**: the route path of the boundary node, injected via
  the island's hydration payload. `actionBase` likewise.
- **Emit a fragment per sub-route.** Hard navigation to
  `/dashboard/settings` assembles a sequence whose island region contains
  the build-time SSR output *for the settings sub-route* (its settled or
  fallback state), with that sub-route's pushes and assets. Island
  subtrees are indistinguishable from pages for hard-nav performance.
- **Record per-sub-route query lists** on the sub-route fragments, so
  deep hard navs announce and carry the right pushes (§4.5).

Soft navigation *within* an island subtree is pure solid-router.

**Double-router rule:** on any link click, PageRouter matches the target URL
against the manifest. If it resolves to the **same route node currently
mounted** (i.e. an island-internal navigation), PageRouter does nothing and
lets IslandRouter handle it. Otherwise PageRouter navigates, regardless of
where the click originated.

### 3.5 Leaf islands

`<Island>` wraps a component for simple interactivity with no routing:

```tsx
<Island><Counter /></Island>
```

There is no `client:load`-style attribute sugar — Solid 2.0 dropped
directives, and one explicit way to mark an island beats two. The build
transform (ported from solid-hybrid's `vite-plugin-island-meta`) locates
`<Island>` elements and **injects hidden props** (stable ID + component
metadata) into the JSX — the same mechanism v1 used for its generated
`__Island` wrappers; the SSR registry and hydration key on those props,
no import-graph analysis. The transform assigns the stable ID, records
the wrapped component's import source as metadata, SSRs the content
into the enclosing fragment, and registers it in the route's client entry
for hydration. Leaf islands may use `usePageQuery` (§4.4) and solid-router
queries/actions, but not IslandRouter.

**Leaf island pages.** A page file with the `.island` suffix
(`name.island.tsx`, `index.island.tsx`) is a page whose default export *is*
the island component — behaviorally identical to a substitution page
containing exactly one full-width `<Island>`, minus the wrapper file. Same
rules as any leaf island: `usePageQuery` and solid-router queries/actions,
no IslandRouter. The build reuses the leaf-island path with the whole page
fragment as the splice target and emits one hydration entry.

A property worth designing around: island SSR output is frozen at build
time and server-side Jinja never touches island markup (§4.4), so a leaf
island page's fragment contains **no substitution slots at all** — it is
always `static`-class, served as raw bytes from CDN, with its data riding
in via pushes and the resolution rule (§4.5). A static shell layout plus a leaf island
page is the intended shape for a simple SPA: zero origin rendering, still
fully dynamic after hydration. This is the pattern §5 advises pushing sites
toward, expressed as a filename.

### 3.6 Intercepting and parallel routes

Parsing is implemented (slots `@name`, fallbacks — as `*name`, to be
renamed `!name` — and intercepts).
Runtime semantics are **deliberately sequenced last** (see §11): the
manifest reserves `slots` and `intercept` fields, and the fragment/sequence
model hosts them naturally (slots are interleaved sub-sequences), but v1
does not implement their runtime behavior.

Intended semantics (recorded for later): an intercept applies on soft
navigation only — PageRouter renders the intercepting fragment into its slot
while the URL updates; hard navigation to the same URL assembles the
non-intercepted sequence. Slots render in parallel outlets with `!default`
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
- `inputs: []` declares a value that varies on nothing in the request: the
  zero-input case of `route` class — rendered on first request, cacheable
  indefinitely (§5).
- **Omitted `inputs` defaults to `['request']`** — private, uncacheable.
  Cacheability is always opt-in; the failure mode of forgetting is slowness,
  never leakage.

Queries are collected into a machine-readable contract
(`.pacifica/schema.json`) consumed by the Rust side (codegen via proc
macro/build script) and by the build itself.

Forms outside islands: page actions, §4.6.

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
manifest `queries` lists, the client-consumed set, and push pruning (§4.5).

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
  and hydration markers would pollute the templates. The addendum spike
  showed one-pass `hydratable: true` rendering is also *viable* — it won't
  corrupt the template (raw placeholders and the `{% for %}` block survive;
  the only change is deterministic `_hk` attributes on element start tags) —
  so a future constraint forcing a single pass would be ugly, not broken.
  The build nevertheless renders **two-pass**: islands SSR'd hydratable in
  isolation, frozen bytes spliced into the non-hydratable page render as
  `{ t }` fragments. Reasons beyond marker-free page shells: Solid numbers
  hydration keys with a per-render counter, so an island rendered mid-page
  would get position-dependent `_hk` values that the island's client
  `hydrate()` call (which numbers from its own root, under its own render
  id) would have to reproduce — isolated renders make each island's keys
  self-contained; and each island's serialized boundary-state script
  (§4.4) stays adjacent to its own markup, per artifact.

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
  fallback is frozen into the island's SSR output. Implementation
  constraint (spike §11.1b): covered values must be returned
  **synchronously** (not `Promise.resolve` — `renderToString` renders the
  non-fallback path iff it sees a non-awaitable value); build-skipped
  values return a never-resolving promise.
- At runtime the signal reads the query cache, which is fed by **pushes**
  (§4.5) — inline scripts embedded in fragment bytes by whoever rendered
  the fragment — and resolves per the resolution rule (§4.5): cache hit →
  sync at hydration; announced → wait for the in-flight bytes; otherwise
  the cache fetches, right then. Island SSR output is **frozen after
  build** — server-side Jinja never touches island markup. The cost:
  non-prerendered `usePageQuery` content shows its fallback between paint
  and hydration (plus a fetch round-trip when the query was never
  announced, §4.5).
- The static lens path lets the build **prune each query's pushes to the
  union of lens paths accessed anywhere in the app** for that query (one
  global prune set per query, recorded in `schema.json` — pushes are
  per-fragment artifacts shared across routes, so the prune set cannot be
  per-route), and doubles as an access manifest.

**Hydration behavior** (spike §11.1c, resolved on 2.0.0-beta.14;
`solid-hydration-overwrite-test/`):

- Frozen-fallback hydration works as this section assumes: hydration
  returns the fallback for the hydrate pass, then swaps in the real content
  in a microtask (pre-rAF) — no warnings, no DOM corruption, event handlers
  attach, siblings outside the boundary hydrate normally. The flash is the
  fallback being visible from first paint until the island script hydrates.
- The swap works because Solid serializes **boundary state alongside the
  markup** (a script setting `_$HY.r[key] = "$$f"` marks the boundary as
  serialized-fallback). A frozen island artifact is therefore markup **plus
  its hydration-state script**, not markup alone.
- **Hydration never overwrites existing DOM content** (`insertExpression`
  is a no-op while hydrating). If frozen markup contains *settled* content
  whose data differs from the pushed data, the stale markup is kept
  silently while client state holds the new data — no error, no warning.
  This is why snapshot atomicity (§6.4) is a correctness requirement, not
  an optimization: violating it produces silent DOM/state divergence. It
  also constrains any revalidation/SWR mechanism: updates must be applied
  via signal writes *after* hydration completes (which work normally),
  never by racing the hydration pass.

### 4.5 Pushes: how query data reaches the client

There is **one delivery rule**, symmetric between build and server:

> **Whoever renders a fragment inlines a push for each client-consumed
> query it ran, embedded in that fragment's bytes.** The build inlines at
> build time (prerendered renders); the server inlines into the
> output it renders at request time. There is no separate streaming
> channel — data travels inside fragment bytes, wherever those bytes go
> (origin response, CDN cache, composed page, soft-nav fetch).

Pushes exist for one consumer: islands reading data by name
(`usePageQuery`, island query preloads). A query used *only* in page
substitution is rendered into markup and needs no push — running a query
and delivering its result to the client are related but distinct; the
**client-consumed set** (defined below) is what separates them.

On an origin-assembled hard navigation the origin goes further: it runs
and pushes **every query in the route's client-consumed set** that is not
already baked into a served artifact — it has the full request context,
so this includes `cookies`/`request`-class queries. Markup and all island
data arrive in **one response**: the single-hop optimization this design
started from. These extra pushes are emitted as standalone script chunks
interleaved between fragments as their results resolve (fragment
boundaries are legal script positions, see Placement). Covered queries
baked into served prerendered artifacts are never re-run (§6.4).

**Wire format.** A push is a self-contained append to a plain array (the
gtag queue-stub pattern — no ordering dependency on the runtime bundle):

```html
<script>__pq=self.__pq||[]</script>                      <!-- stub, in <head> -->
<script>__pq.push(["q","nav",{"items":["…"]}])</script>  <!-- one push -->
```

The build injects the one-line stub into the `<head>` during the root
layout render. Pushes execute synchronously during the streaming parse, so
data is queued before any island entry script runs; the client runtime
drains `__pq` into the query cache (`query.set`) and replaces `push` when
it loads. Pushed values are pruned to the query's global lens-path union
(§4.4).

**Placement.** A push sits at the start of the fragment's bytes,
uniformly — no renderer special cases. The build makes this safe with the
document preamble split (§3.2): `_root/doc` carries the doctype/head, and
the root render's pushes are assigned to `_root/0`, its first
body-contained piece, so no push ever precedes the doctype. Position
within the document is not load-bearing — island hydration runs from
deferred entry scripts, after all inline pushes have executed — only
same-response delivery is. Fragment
boundaries are outlet positions — always element child positions — and
HTML content models permit `<script>` at effectively every such position
(the "script-supporting elements" clause covers `table`, `tr`, `select`,
`ul`, `dl`, …). Two positions are **build errors**: an outlet inside a
raw-text element (`title`, `textarea`, `style` — no legal script position)
and an outlet inside foreign content (`svg`/`math` — SVG `<script>`
semantics differ; punted).

**Dedup and the `pushes` field.** Within one render, a layout that ran a
query pushes it once, in its **first piece** (document order). This makes
"queries a fragment depends on" and "pushes physically in a fragment's
bytes" different sets — `_root/1` depends on `site-config` but carries no
push. The manifest records both: `fragments[*].queries` is dependency
accounting (rendering, cache class inputs); `fragments[*].pushes` is the
physical push assignment (§9). **Announce computation and PageRouter's
expected-push set read `pushes`, never `queries`** — inferring pushes
from the dependency list would double-count split layouts. Across
fragments in one response, duplicate pushes of the same query remain
possible (two different renders sharing a query) and harmless: within one
build (or one response) the values are identical by construction, and
`query.set` is idempotent; last-wins.

**The announce and the resolution rule.** Every hard-nav response begins
with an **announce** — an early push, in the preamble, listing exactly
the queries this response will deliver:

```html
<script>__pq.push(["announce",["site-config","product"]])</script>
```

Whoever writes the response knows the list: the origin computes it after
its per-fragment prerender stats (the baked pushes of the artifacts it
will serve, plus everything it will run itself — which on origin hard
navs is the route's full client-consumed set); composed-page derivation
bakes the announce of the artifacts it concatenated. Because the announce
travels **in the bytes**, a CDN caching an origin response preserves it
automatically — no headers, no serving-mode detection, nothing for a
cache to strip.

The query cache resolves against it, synchronously, at the point of use
(`usePageQuery`, island query preloads):

> **Cache hit** → resolve now. **Announced** (hard nav) or **in
> PageRouter's expected-push set** (soft nav, §3.3) → stay pending: the
> push is already in these bytes. **Otherwise** → fetch from
> `queries[name].url` (envelope protocol), right now.

No `DOMContentLoaded` coupling, no in-flight detection, no waiting on
parse completion: the announce parses in the preamble, before any island
entry script runs, and it is exact. (If a stream dies after its announce,
the client may fetch announced-but-missing queries on stream error — an
error path, not the design.)

**The client-consumed set** is derived by the build: queries some island
actually reads (`usePageQuery` accesses — i.e. a non-empty prune set). A
query used only in page substitution has no client consumer: it is never
announced, pushed, or client-fetched — its data lives in the markup.

If a query was rendered into any fragment of the response, its push
arrived with that fragment's bytes; anything still missing was never
coming.

**Query cache classes.** Queries derive a cache class from their `inputs`
exactly like fragments: `inputs ⊆ params/search` → the endpoint is a
deterministic GET (params in the URL template, canonical search ordering)
that is **publicly CDN-cacheable**, with a prebaked `Cache-Control` string
in `schema.json`; `cookies`/`headers`/`request` → private, always origin.
Client fetches of cacheable queries therefore cost a CDN round-trip, not
an origin one.

**Latency mitigations (optional, never correctness):** prebaked
`Link: …; rel=preload; as=fetch` strings per route for client-fetched
queries (origin header or CDN config); composed pages may inline the
equivalent `<link rel=preload>` at derivation time. And
`export const prerender = false` (§6.1) forces origin assembly for a
subtree when single-response delivery is wanted.

**Soft navigation.** Scripts inserted via `innerHTML` never execute;
PageRouter re-creates each script element found in fetched fragment bytes
(the same mechanism frozen islands' `_$HY.r` boundary-state scripts
already require). No announce: PageRouter chose each fragment's source
itself, so it knows the expected-push set (§3.3).

### 4.6 Page actions (forms outside islands)

Pages are substitution-only, but they may contain plain HTML forms. Two
layers, both against the same Rust action endpoints and envelope (§4.3):

- **No JS:** `<form method="post" action="…">` posts natively; the
  handler content-negotiates and answers `303 See Other`. Zero framework
  involvement — works before hydration and with JS disabled.
- **With JS:** PageRouter intercepts form submissions the way it
  intercepts link clicks, posts via fetch, and handles the envelope —
  `redirect` navigates (soft), `queries` entries feed the cache,
  `revalidate` keys self-route (§4.3). Progressive enhancement of the
  same form.

`pageAction<T>('/api/thing')` is a typed helper binding a form to its
endpoint — it emits plain `action`/`method` attributes and typed field
names, no client state, no island. Islands keep using solid-router
actions (§4.3); page actions are the no-island path to the same
endpoints, same envelope, same handlers. Sequenced with PageRouter
(§11.6).

## 5. Rendering classes

The class of every fragment is **derived, never authored**:

| Inputs used by the fragment's queries | Class | Rendered | Cache-Control default |
|---|---|---|---|
| (no queries at all) | `static` | at build | `public, max-age=…, immutable`-style |
| ⊆ `{param*, search*}` (including all `[]`) | `route` | at request time | `public, s-maxage=…, stale-while-revalidate=…` |
| any of `cookies`/`headers`/`request` | `request` | per request | `private, no-store` |

- Response headers for a hard nav = meet (most restrictive) of the
  sequence's fragments — but the *work* is per-fragment: static fragments
  are served as bytes, only dynamic fragments are executed (§3.2).
- `<CacheControl>` can only tighten.
- Class derives from **substitution-accessed queries only** (the proxy
  record, §4.2): island-consumed queries (`usePageQuery`) never affect a
  fragment's class — island markup is frozen, so they cannot vary the
  bytes. They still appear in the fragment's manifest `queries` list for
  delivery accounting (announce/pushes, §4.5). This is why a leaf island
  page reading `cookies` data is still `static`.
- `headers` maps to `request` in v1. (A future extension may allow
  `{ header: 'accept-language' }` entries emitting `Vary`; explicitly out of
  scope now.)
- **There is no boot-time class.** A fragment whose queries all declare
  `inputs: []` is the zero-input case of `route`: empty binding, rendered
  on first request. This preserves the property boot-time rendering was
  for — values come from the runtime environment, not the build — with
  better freshness semantics (a zero-input result may still change over
  time; cache policy handles it, process lifetime doesn't). Zero-input
  fragments get their own prebaked long-public `Cache-Control` default.
- The origin **may** memoize `route`-class renders keyed by binding (the
  class data makes this safe by construction). Pure optimization, never
  semantics; with a CDN in front it is usually unnecessary.
- Exact `Cache-Control` strings and `Link` header values are **prebaked into
  the manifest** by the build. The server copies strings.

A per-segment consequence worth designing sites around: one `request`-class
segment makes the *response* private (hard navs pay for it in headers), but
soft navs still fetch the other fragments from CDN, and the server only
executes the dynamic fragment. Push dynamism into leaf fragments, or better,
into islands + client-fetched queries, and HTML stays cacheable (the
"static + APIs" end of §6.6's spectrum is this advice made structural).

## 6. Prerendering (SSG)

Prerendering renders `route`-class content at build time for enumerated
bindings. It is **per-binding coverage of route-class fragments**, not a
fourth class.

**Prerendering is params-only.** A binding assigns route params and
nothing else — no search, no cookies, no headers. Consequences, each
load-bearing:

- The prerender cache key is **exactly the URL path bytes** — the same
  thing CDNs key on natively. Nothing that isn't the URL path can ever
  address a public prerendered artifact; the cache-key-overlap class of
  bug (user A's variant served to user B) is structurally impossible here.
- Every binding component has a **position** in the fragment's own name
  (`[locale]/products/[id]`), so artifact paths need no canonical key
  ordering — the path slots are the ordering (§6.5).
- Content that varies on search (or anything request-borne) is honestly
  `route`/`request`-class at runtime. Prerendering is the wrong tool for
  it; the origin serves it with explicit cache semantics.

Corollary constraint, enforced at build: **a fragment's queries may only
use params from the fragment's own path prefix.** (Otherwise a layout
fragment could vary on a param declared below it — a key component with no
path position.)

Invariant that keeps artifact counts sane: **every fragment has exactly one
build-rendered form** (the "all non-covered queries pending" form — an
unresolved async signal always renders the same fallback, so dynamism never
forks build output), **plus one form per covered binding**. Nothing else
multiplies.

### 6.1 Enumeration

**Prerendering is an optimization, not a mode.** The build prerenders
every fragment it can prove coverage for, by default. Zero-param
fragments are always coverable (the empty binding), so they prerender by
default — including the root layout's numbered pieces (though never the
preamble, §3.2). Param-bearing fragments become coverable when a
`prerender` export enumerates values.

Route files export their prerender config; declarations **inherit down
the route subtree**; `params` entries compose by cartesian product;
deeper routes may extend or override. Enumerations yield **params only**,
and bindings live under a `params` key so future config (revalidation,
caching — §6.4) is additive rather than a refactor:

```tsx
// src/routes/[locale]/_layout.tsx
export const prerender = { params: { locale: ['en', 'de', 'fr'] } };

// dynamic enumerations allowed; must resolve before the render pass
export const prerender = async () => ({
  params: { id: await fetchAllProductIds() },
});

// opt-out: no build artifacts for this subtree; every hard nav assembles
// at the origin (single-response delivery of markup + pushes), and
// zero-input queries resolve at request time
export const prerender = false;
```

`prerender = false` is the freshness escape hatch. Default-on means
zero-input queries (env-derived site config, say) resolve at **build**
time — consistent with their long-public cache default (§5), which
already made them effectively build-epoch data even when
runtime-rendered; a subtree that wants request-time values opts out.
Prerendering needs `--query-origin` at build (§6.2); if it isn't
configured, the build skips prerendering and reports, rather than
failing.

`prerender = false` inherits down the subtree like any other declaration.
It exists for origin-assembly semantics — freshest route-class data per
request, no build artifacts to invalidate — not for data delivery, which
works without it (§4.5).

### 6.2 Data source

The build fetches query results over the **same protocol as runtime**,
against a configured `--query-origin` (staging, prod, or a fixtures stub).
The build is just another query client; no build-time coupling to Rust code.

### 6.3 Coverage and fulfillment

- A fragment is prerenderable for a binding iff the binding covers **every
  named param input of every query the fragment uses** (known from proxy
  tracking + declarations). Queries with bare `'param'` require a fully
  bound enumeration. Queries with any `search:*` input are never
  prerenderable (§6 intro).
- Prerendered fragments are keyed by **only the params they use**: a header
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
- **Composed pages:** for routes whose entire sequence is covered for a
  binding, the build also emits the whole page into the `html/` URL tree
  (`html/en/products/42/index.html`, §6.5) — derived by **pure
  concatenation** of the fragment artifacts in sequence order (pushes are
  already inside fragment bytes). When all routes are covered, `html/`
  deploys as a complete static site with no origin server. The origin
  never uses composed pages; it always assembles.

### 6.4 Snapshot atomicity (the consistency rule)

A prerendered fragment's markup embeds build-time data, and hydration reads
pushed data. These must never disagree. The push model (§4.5) makes the
rule **physical** rather than procedural:

> A prerendered artifact is markup **with its pushes inlined in the same
> file**, written in one build. Markup and data cannot desync because
> there is nothing to desync: the server serves the bytes as-is and never
> re-runs covered queries. The artifact changes only on rebuild.

Uncovered (runtime) queries are delivered fresh — pushed by the server
fragments that run them, by the origin's single-response delivery, or by
client fetch per the resolution rule (§4.5).

Empirically load-bearing (spike §11.1c): violating this rule does **not**
error — Solid hydration silently keeps the stale markup while client state
holds the fresher data (§4.4). Silent divergence, not a crash, is the
failure mode this rule prevents.

One constraint this bequeaths to future incremental regeneration: because
two artifacts may carry pushes of the same (query, binding) pair, the
regeneration unit for a binding is **all artifacts whose pushes mention an
affected (query, binding)** — regenerating a subset could put two
disagreeing pushes in one response (last-wins, silently).

**Future: revalidation (parked, direction settled).** v1 prerendered
artifacts are static-until-rebuild, full stop. The eventual
stale-while-revalidate design is incremental regeneration (§6.5 keeps the
door open): executed at the **origin** (a dumb CDN cannot regenerate — it
gets purged), configured by additional `prerender` properties alongside
`params` (e.g. `revalidate`) — which is why bindings are nested under
`params` (§6.1) — and bound by the regeneration-unit constraint above.
Deeper design deferred until the feature is scheduled.

### 6.5 Layout on disk and lookup

A prerendered artifact's path is the fragment's name with its **bound
param slots positionally substituted**; unbound slots stay literal (a
value can never read `[locale]` — brackets get encoded). Deterministic,
index-free, and every path is also a URL the client can construct:

```
.pacifica/html/_pacifica/            # reserved prefix inside html/ (§8)
  en/_nav/0.html                     # [locale]/_nav/0 for {locale: en}
  de/_nav/0.html
  en/products/42.html                # [locale]/products/[id] for {locale: en, id: 42}
  en/products/[id].html              # a fragment that used only locale: unused slot literal
```

**Value encoding.** Param values are written canonically
percent-encoded: every byte outside unreserved `[A-Za-z0-9._~-]` is
encoded. One tiny function, byte-identical in the build, both servers, and
PageRouter. Consequences: no traversal class (encoded values cannot
contain `/`; a malicious `%2E%2E` stays the literal bytes `%2E%2E`),
Windows/macOS-inspectable artifacts, and URL round-tripping for free.
Deploy target is Linux (filenames are byte blobs); one accepted caveat:
two bindings differing only by letter case collide on a case-insensitive
dev filesystem (macOS). Build errors: param values of `""`, `.`, `..`, or
longer than 200 bytes encoded (too long for a path component — not
prerenderable, falls to runtime).

**Lookup** (server, per fragment, per request): substitute the request's
params into the fragment name's slots for exactly the fragment's
`prerender.inputs`, `stat` the path. Hit → serve those bytes as-is
(pushes included; headers still the sequence meet). Miss → render that
fragment at runtime with its derived class — a miss (e.g. a non-canonical
encoding that slipped through normalization) is graceful degradation,
never a wrong answer. String substitution plus a stat; no index to
maintain.

**Composed pages** land in the `html/` URL tree as
`<encoded-url-path>/index.html` — directory-index style, the convention
every dumb host honors without rewrite rules. Catch-all param values
contain slashes and simply become nested directories in URL space.

The build also emits `html/_pacifica/bindings.json` (path → binding, for
humans and tooling). **No runtime reads it** — it is not an index in the
lookup sense.

Build cost scales with the enumerated matrix; param-keyed coalescing keeps
shared fragments to one render each. Incremental/on-demand regeneration of
single bindings is future work (see the §6.4 regeneration-unit
constraint); the binding-keyed artifacts being additive files is what
keeps that door open.

### 6.6 The serving spectrum (illustrative — nothing implements this)

Serving is a **per-fragment** fact, not a site mode: `html/` and
`fragments/` are not either-or — they coexist in one deployment, and a
single response can mix CDN-cacheable prerendered bytes with
origin-rendered ones (§6.3). The spectrum below is vocabulary for
describing sites; no runtime switches on it and the manifest does not
record it:

- **Pure static** — every sequence fully covered: `html/` alone deploys;
  no origin at all.
- **Static + APIs** — HTML entirely from CDN; an origin serves only
  query/action endpoints; personalization rides island-fetched queries
  (§4.5).
- **Hybrid** — most real sites, mcmaster included: covered fragments from
  CDN, `route`/`request` fragments origin-rendered, one manifest, one
  deployment.
- **Full origin** — nothing covered (`prerender = false` everywhere):
  every hard nav assembles at the origin.

What *is* real: the build reports where each route lands and why
("`user-info` is used in page substitution here — that forces origin
assembly; move it into an island to stay static").

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
   route's sequence. Inline pushes for the queries each render ran (§4.5);
   inject the queue stub into the root layout's head.
6. **Client entry codegen** — per route: hydration entries for its islands,
   IslandRouter bootstrap for island subtrees, the PageRouter runtime.
7. **Client build** — `vite build` → `.build/client/bundle` + Vite manifest.
8. **Manifest assembly** — join both Vite manifests to map every fragment
   and route to its assets (transitive chunk graph, CSS dedup,
   server-emitted CSS); derive classes; prebake
   `Cache-Control` and `Link` strings; sort route children by specificity;
   write `manifest.json` and `schema.json`; populate `html/` (assets,
   public, static-class fragments, prerendered artifacts under the
   reserved prefix, composed pages for covered routes, `bindings.json`)
   and `fragments/` (route/request templates).

## 8. `.pacifica` directory

The `.pacifica` directory **is the server API.** Stability of this layout is
a compatibility promise.

The organizing invariant: **`html/` holds every byte that is final at
build time; `fragments/` holds everything that still needs execution.**
`html/` is the complete CDN sync target with no filtering — `rsync html/
cdn:/` is the whole static-deploy story, and every project has one (at
minimum assets + public), whether or not it prerenders anything.

```
.pacifica/
  manifest.json           # everything the server needs to decide anything
  schema.json             # query contracts, cache strings, prune sets (Rust codegen input)
  fragments/              # Jinja templates only, executed per request
    _root/doc.html        #   document preamble: {{ __pacifica.assets }} (§3.2)
    _root/0.html          #   (also has a prerendered form by default, §6.1)
    account/orders.html
  html/                   # final at build; served as-is (CDN or origin)
    public/…              # user's public dir, copied verbatim
    static/…              # hashed client assets (js/css/fonts…)
    _pacifica/            # reserved prefix: fragment artifacts at constructible paths
      about.html          #   static-class single forms
      en/_nav/0.html      #   prerendered, params positionally substituted (§6.5)
      en/products/42.html
      bindings.json       #   debug map, no runtime reads it
    en/products/42/index.html   # composed pages, URL space (§6.5)
```

The reserved prefix (`_pacifica/`, configurable) is a **build error** if a
user route collides with it. Files in `fragments/` are Jinja-executable
templates; everything under `html/` is bytes.

### 8.1 Fragment naming

There are two namespaces, and the manifest is the only mapping between
them:

- **Route space** — URL-shaped (`/[locale]/products`). Appears only as
  keys in the manifest (`sequences`, the route tree). Params use the same
  `[name]` syntax as the filesystem — one param representation everywhere.
- **Fragment space** — filesystem-shaped: fragment names mirror the source
  tree under `src/routes/` verbatim, minus the `.tsx`/`.ts` extension.
  Used as artifact paths (under `fragments/` or `html/_pacifica/`,
  depending on class — see below) and as keys in the manifest's
  `fragments` section.

Rules:

- A page file maps 1:1: `about.tsx` → `about.html`;
  `[locale]/products/[id].tsx` → `[locale]/products/[id].html`.
- A layout becomes a directory of numbered pieces, one more than its
  outlet count: `_root.tsx` → `_root/0.html`, `_root/1.html`. The `_`
  prefix is kept.
- The root layout additionally yields the document preamble `_root/doc`
  ahead of its numbered pieces (§3.2).
- Group directories and index-alias names are kept: `(marketing)/pricing.tsx`
  → `(marketing)/pricing.html`; `(home).tsx` → `(home).html`; `index.tsx`
  → `index.html`.
- The `.island` suffix is kept: `app.island.tsx` → `app.island.html`, so a
  directory listing distinguishes frozen island bytes from Jinja-executable
  templates.
- An island boundary layout contributes **no fragments of its own** — its
  markup is baked into each sub-route's frozen SSR. Island sub-route
  fragments are named by their sub-route files (`dashboard/settings.html`),
  uniform with pages.
- `.script.ts(x)` files produce no fragments; they surface as assets on
  sequences.

Fragment names are **opaque tokens** everywhere downstream. A sequence is a
list of them; each token is the key into the manifest's `fragments`
section, and that entry's `class` decides where the bytes live: `static` →
`html/_pacifica/<name>.html` (final bytes), `route`/`request` →
`fragments/<name>.html` (template), prerender hits →
`html/_pacifica/<substituted name>.html` (§6.5). Nothing ever parses a
fragment name — brackets, parens, `_`, `!` are just bytes; substitution
fills slots the manifest already names. Matching, the one job that
historically forced name-encoded conventions (`%`, `*`, `?`), instead uses
the route tree's explicit `segment`/`param` fields. Mirroring the
filesystem also makes the alphabet Windows-legal by construction: `[id]`,
`(group)`, `@slot`, `!404` are valid NTFS names, unlike `:id` or `*404`.

Example (fragment names → where their bytes live; classes assumed):

```
src/routes/                        artifact
  _root.tsx                          fragments/_root/{0,1}.html        (route: site-config)
  (home).tsx                         html/_pacifica/(home).html        (static)
  about.tsx  + about.script.ts       html/_pacifica/about.html         (static; script → assets)
  !404.tsx                           html/_pacifica/!404.html          (static)
  (marketing)/_layout.tsx            html/_pacifica/(marketing)/_layout/{0,1}.html
  (marketing)/pricing.tsx            fragments/(marketing)/pricing.html (route: plans)
  [locale]/_nav.tsx                  fragments/[locale]/_nav/{0,1}.html (route: nav)
                                     + html/_pacifica/{en,de}/_nav/{0,1}.html (prerendered)
  [locale]/products/[id].tsx         fragments/[locale]/products/[id].html
  account/orders.tsx                 fragments/account/orders.html     (request: orders)
  dashboard/_dash.island.tsx         (no fragment — baked into sub-routes)
  dashboard/settings.tsx             html/_pacifica/dashboard/settings.html (static, frozen island SSR)
  app.island.tsx                     html/_pacifica/app.island.html    (static)
```

## 9. `manifest.json`

Sections: `version`, `routes`, `sequences`, `fragments`, `queries`.
(A complete worked example is in §13.)

```jsonc
{
  "version": 1,

  "routes": {
    "segment": "/",
    "sequence": "/",                        // key into "sequences"
    "fallback": { "404": { "sequence": "/!404" } },
    "children": [                           // pre-sorted by specificity
      {
        "segment": "products",
        "sequence": "/products",
        "children": [
          {
            "segment": "[id]", "param": "id",
            "sequence": "/products/[id]"
          }
        ]
      },
      {
        "segment": "dashboard",
        "islandRouter": { "base": "/dashboard", "actionBase": "/actions" },
        "sequence": "/dashboard",
        "children": [ /* island sub-routes: own sequences */ ]
      }
    ]
    // reserved: "slots", "intercept" (parsed today, runtime later)
  },

  "sequences": {
    "/products/[id]": {
      "fragments": ["_root/doc", "_root/0", "products/[id]", "_root/1"],
      "cacheControl": "public, s-maxage=300, stale-while-revalidate=3600",
      "linkHeader": "</assets/products-D3ax.css>; rel=preload; as=style, …",
      "assetsHtml": "<link rel=\"stylesheet\" href=\"/static/products-D3ax.css\">…",
      "assets": {
        "css": ["products-D3ax.css"],
        "jsEntry": "products-9k2a.js",
        "jsImports": ["chunk-solid-Bf1x.js"]
      }
    }
  },

  "fragments": {
    "_root/doc":  { "class": "route", "queries": [], "pushes": [],
                    "cacheControl": "…" },      // preamble: assets substitution (§3.2)
    "_root/0":    { "class": "route", "queries": ["site-config"],
                    "pushes": ["site-config"],  // first piece of the render (§4.5)
                    "cacheControl": "…" },      // zero-input route class
    "_root/1":    { "class": "route", "queries": ["site-config"],
                    "pushes": [],               // dependency, but no physical push
                    "cacheControl": "…" },
    "products/[id]": { "class": "route", "queries": ["product"],
                    "pushes": ["product"],
                    "cacheControl": "…",
                    "prerender": { "inputs": ["param:id"] } }
  },

  "queries": {
    "site-config": { "url": "/api/site-config", "inputs": [] },
    "product":     { "url": "/api/products/{id}", "inputs": ["param:id"] },
    "user-info":   { "url": "/api/user-info", "inputs": ["cookies"] }
  }
}
```

Notes:

- `sequences` entries carry the response-level prebaked strings (headers,
  assets) for hard navs; `fragments` entries carry per-fragment class,
  queries, cache headers (used when a fragment is served alone for soft
  nav), and prerender coverage.
- Param segments use the filesystem's `[name]` syntax — one param
  representation everywhere. Matchers identify param nodes by the `param`
  field; the segment string of a param node is never parsed.
- There is **no `preloads` field**: a route's client-consumed query set
  (§4.5) is derived from its sequence fragments' `queries` lists
  intersected with the client-consumed queries in `schema.json` (island
  sub-route fragments carry their query lists like any other fragment).
  Denormalizing this back into the route tree is a possible later
  optimization, not a manifest shape.
- Fallbacks are not URLs, so their sequences are keyed by fragment-space
  name (`"/!404"`); sequence keys are route paths *or* fallback names.
- `assetsHtml` is the preamble's substitution value (§3.2): the
  sequence's asset tags as one prebaked string, spliced into
  `{{ __pacifica.assets }}` by the origin per request or by composed-page
  derivation at build.
- `queries` vs `pushes` (§4.5): `queries` records what a fragment
  *depends on* (rendering inputs, class derivation, delivery accounting);
  `pushes` records what is *physically in its bytes* — split layouts put
  the render's pushes in the first piece only, and queries without client
  consumers are never pushed. Announce computation and PageRouter's
  expected-push set read `pushes`; nothing infers pushes from `queries`.
- Invariant: **every decision a server or client router must make is a
  lookup in this file.** If an implementation needs logic beyond
  tree-walking, string assembly, and template execution, the manifest is
  missing a field.

## 10. Server contract

Any conforming server (reference implementation: TypeScript; production
target: Rust — a *port*, started only once this spec stabilizes):

1. Load `manifest.json` at startup. **No boot-time rendering** — there is
   no startup work beyond reading the manifest (§5).
2. Per request: match segments against `routes` (children are pre-sorted;
   walk in order, extract params). Miss → nearest `fallback.404`.
3. Determine the unit: a single fragment if the request carries the
   soft-nav indicator (header `X-Pacifica-Partial` or equivalent), else the
   route's sequence.
4. Stat the sequence's prerenderable fragments (§6.5: substitute the
   request's params into the fragment name for each fragment's
   `prerender.inputs`, stat under `html/_pacifica/`) and compute the
   **announce** (§4.5): the union of the served fragments' `pushes`
   (manifest — never inferred from `queries`, §9) plus everything the
   origin will run itself; on a hard nav that total is the route's full
   client-consumed set. Then, for each fragment in sequence order:
   a. The preamble (`_root/doc`): execute its template, splicing the
      sequence's `assetsHtml` string; the announce rides here.
   b. Prerender hit → those bytes as-is (pushes included; covered
      queries never re-run, §6.4).
   c. `static` → the bytes at `html/_pacifica/<name>.html`, as-is.
   d. Otherwise run the fragment's `queries` (context restricted to each
      query's declared `inputs`), execute the fragment's template from
      `fragments/` (Jinja subset; engine parity plan: minijinja in Rust /
      minijinja-js in the reference server — punted until templating DX is
      settled), and **inline a push for each client-consumed query it
      ran** at the start of the rendered bytes (§4.5).
   Announced client-consumed queries no fragment delivers (island-only,
   e.g. `cookies`-class) are run concurrently and pushed as standalone
   chunks between fragments as they resolve — single-response delivery
   (§4.5). Stream fragments in document order as they become ready.
5. Copy the sequence's prebaked `cacheControl` and `linkHeader` strings
   (fragment-level strings when serving a lone fragment). Optionally emit
   `103 Early Hints` from `linkHeader` (proven in the solid-hybrid PoC).
6. Serve `html/` as static files (immutable/long cache headers for
   `static/`, per-manifest strings elsewhere). A CDN may front or replace
   this entirely (§6.6).
7. Query/action endpoints respond with the envelope (§4.3), content-
   negotiating JSON vs `303` for no-JS form posts. Endpoint `Cache-Control`
   strings come prebaked from `schema.json` per the query's cache class
   (§4.5).
8. The origin may additionally memoize `route`-class renders keyed by
   binding (§5). Optional; never semantics.

## 11. Sequencing

1. **Spikes first** (all against SolidJS 2.0, all cheap, all load-bearing):
   a. ~~the tracking-proxy `t`-property technique on 2.0's SSR~~ —
      **RESOLVED** (2026-07-03, `solid-tracking-proxy-text/`): PASS on
      2.0.0-beta.14 with modifications, folded into §4.2 mechanism notes.
      Addendum also resolved: emission survives `hydratable: true`
      unchanged (deterministic `_hk` attributes only), so one-pass
      island-in-page rendering is viable; two-pass splice kept as the
      default for marker-free page shells.
   b. ~~selective async-signal resolution + settled-render capture with
      frozen suspense fallbacks (build render pass, §6.3)~~ — **RESOLVED**
      (`solid-prerender-test/`): sync value → real content, pending
      promise → `Loading` fallback, in one `renderToString` pass on
      2.0.0-beta.14. This is the source of the §4.4 note (covered values
      must return synchronously; skipped values return a never-resolving
      promise).
   c. ~~hydration overwriting frozen fallback markup via signals (no
      mismatch breakage, acceptable flash)~~ — **RESOLVED** (2026-07-03,
      `solid-hydration-overwrite-test/`): PASS in Chromium. Fallback swap,
      clean covered-case hydration, and interactivity all verified; frozen
      artifacts must include Solid's serialized boundary-state script;
      hydration never overwrites settled DOM (stale snapshots persist
      silently) — folded into §4.4 and §6.4.
   A failed spike changes the affected API's *mechanism*, not the
   architecture (e.g. proxy → explicit typed components).
2. Route matching completion + known parser fixes (~~`.script.ts` files
   leak into route segments — missing `continue` in `routes.ts`;
   child-overwrite bug in `mergeManifestRoutes`~~ — fixed 2026-07-03;
   params/catch-all/fallback matching; restore source↔fragment
   association; `.island` suffix parsing + boundary/leaf flags and their
   parse errors, §3.4–3.5; fallback prefix rename `*name` → `!name`).
3. Island system port (transform + `Island` + hydration registry **with
   disposal**, designed in from the start).
4. Build pipeline (§7) — port of v1 onto v2 routes, plus fragment split.
5. TypeScript reference server (§10) — port of the solid-hybrid HTTP/2 PoC,
   plus sequence assembly/streaming.
6. PageRouter runtime (§3.3) + form interception (§4.6).
7. Queries: `pageQuery`, proxy tracking, envelope wrappers, `usePageQuery`,
   pushes + announce + resolution rule, revalidation routing.
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
  a derived output (pure concatenation) in the `html/` URL tree for dumb
  static hosting (§6.3, §6.5).
- **seroval / JS server functions** — rejected; plain JSON envelope against
  typed contracts.
- **SSE for preload delivery** — rejected; script chunks + client fetches.
- **A `startup` render class** (boot-time rendering of zero-input
  fragments) — collapsed into `route` as the empty-binding case
  (2026-07-04): first-request rendering preserves runtime-env values with
  better freshness semantics, and the server gets zero boot-time work.
- **A server-streamed preload channel separate from fragment bytes** —
  superseded by renderer-inlined pushes + the announce/resolution rule
  (§4.5): CDN-served bytes carry their own data and declare their own
  delivery set; no headers, no serving-mode detection.
- **Search/cookie/header inputs in prerender bindings** — rejected
  (2026-07-04); prerendering is params-only, keyed by URL path bytes
  (§6). Search-varying content is `route`-class at runtime.
- **Name-encoded binding keys with canonical key ordering (`id=42&locale=en`)
  and hashed binding keys** — both superseded by positional substitution
  into the fragment name's param slots (§6.5), which params-only
  prerendering made possible.
- **Island props from page data** (`$query` prop references) — rejected in
  favor of `usePageQuery`; island SSR markup stays frozen, nothing is
  prop-lowered.
- **Authored cache classes** (`site|route|request` as user-facing scopes) —
  rejected; classes are derived from query `inputs`, overrides only tighten.
- **JS SSR at request time** — the founding non-goal.

## 13. Worked example

One application exercising every mechanism. Everything below maps back to
a numbered section.

### 13.1 Source

```
src/routes/
  _root.tsx              # html shell; uses site-config (inputs: []);
                         #   contains a ThemeToggle island reading site-config
  (home).tsx             # index alias (§3.1); no queries
  about.tsx              # no queries
  !404.tsx               # fallback (§3.1)
  [locale]/
    _nav.tsx             # uses nav (inputs: [param:locale]); exports
                         #   prerender = { params: { locale: ["en", "de"] } }
    products/
      index.tsx          # uses product-list (param:locale, search:page)
      [id].tsx           # uses product (param:id, param:locale);
                         #   contains a BuyButton island reading product via
                         #   usePageQuery; prerender extends params
                         #   with { id: [42, 43] }
  account/
    orders.tsx           # uses orders (inputs: [cookies]); no islands
  dashboard/
    _dash.island.tsx     # island boundary (§3.4)
    index.tsx            # island sub-routes; settings reads user-info
    settings.tsx         #   (inputs: [cookies]) via usePageQuery
  app.island.tsx         # leaf island page (§3.5)
```

Derived classes (§5): `(home)`, `about`, `!404`, `dashboard/*`,
`app.island` → `static`; `_root/*` → `route` (zero-input);
`[locale]/_nav/*`, `[locale]/products/*` → `route`;
`account/orders` → `request`. The build reports (§6.6): *`orders` is used
in page substitution in `account/orders` — that route needs origin
assembly; every other route serves from CDN.*

Prerender coverage (§6.3): `_root/*` and all `static` fragments by
default (§6.1); `_nav` pieces for `{en, de}`;
`products/[id]` for `{en, de} × {42, 43}`; `products/index` never
(search input). Client-consumed queries (§4.5): `site-config`
(ThemeToggle), `product` (BuyButton), `user-info` (settings island).
`nav`, `product-list`, `orders` have no island consumers: never announced,
pushed, or fetched — their data lives in markup.

### 13.2 `.pacifica`

```
.pacifica/
  manifest.json
  schema.json
  fragments/                             # templates, executed per request (§8)
    _root/doc.html                       # preamble: stub + {{ __pacifica.assets }}
    _root/0.html
    _root/1.html
    [locale]/_nav/0.html
    [locale]/_nav/1.html
    [locale]/products/index.html
    [locale]/products/[id].html
    account/orders.html
  html/                                  # final bytes; the CDN sync target (§8)
    public/…
    static/root-D3ax.css
    static/root-9k2a.js …
    _pacifica/                           # reserved prefix (§8)
      _root/0.html                       # empty-binding prerenders (§6.1 default)
      _root/1.html
      (home).html
      about.html
      !404.html
      app.island.html
      dashboard/index.html
      dashboard/settings.html
      en/_nav/0.html                     # prerendered (§6.5)
      en/_nav/1.html
      de/_nav/0.html
      de/_nav/1.html
      en/products/42.html
      en/products/43.html
      de/products/42.html
      de/products/43.html
      bindings.json
    index.html                           # composed pages (§6.5): every fully
    about/index.html                     #   covered route × binding
    app/index.html
    dashboard/index.html
    dashboard/settings/index.html
    en/products/42/index.html
    en/products/43/index.html
    de/products/42/index.html
    de/products/43/index.html
```

Composed-page accounting: `_root/0` and `_root/1` prerender by default
(zero-param → empty binding, §6.1), and the preamble is baked per page at
derivation, so **every route whose remaining fragments are covered gets a
composed page** — `/`, `/about`, `/app`, `/dashboard`,
`/dashboard/settings`, and the four product bindings. Two routes get
none: `/en/products` (`product-list` reads `search:page`, never
coverable) and `/account/orders` (`request`-class) — hard navs to those
assemble at the origin. Had `_root.tsx` exported `prerender = false`, no
composed pages would exist anywhere (the root is in every sequence); the
build reports that consequence rather than silently emitting nothing.

### 13.3 `manifest.json`

```jsonc
{
  "version": 1,
  "routes": {
    "segment": "/", "sequence": "/",
    "fallback": { "404": { "sequence": "/!404" } },
    "children": [                        // pre-sorted: static > param (§3.3)
      { "segment": "about",   "sequence": "/about" },
      { "segment": "account", "children": [
          { "segment": "orders", "sequence": "/account/orders" } ] },
      { "segment": "app",     "sequence": "/app" },
      { "segment": "dashboard", "sequence": "/dashboard",
        "islandRouter": { "base": "/dashboard", "actionBase": "/actions" },
        "children": [
          { "segment": "settings", "sequence": "/dashboard/settings" } ] },
      { "segment": "[locale]", "param": "locale", "children": [
          { "segment": "products", "sequence": "/[locale]/products",
            "children": [
              { "segment": "[id]", "param": "id",
                "sequence": "/[locale]/products/[id]" } ] } ] }
    ]
  },

  "sequences": {
    "/":                        { "fragments": ["_root/doc", "_root/0", "(home)", "_root/1"],
                                  "cacheControl": "…", "linkHeader": "…",
                                  "assets": { "css": ["root-D3ax.css"],
                                              "jsEntry": "root-9k2a.js",
                                              "jsImports": ["chunk-solid-Bf1x.js"] } },
    "/about":                   { "fragments": ["_root/doc", "_root/0", "about", "_root/1"], "…": "…" },
    "/!404":                    { "fragments": ["_root/doc", "_root/0", "!404", "_root/1"], "…": "…" },
    "/[locale]/products":       { "fragments": ["_root/doc", "_root/0", "[locale]/_nav/0",
                                    "[locale]/products/index",
                                    "[locale]/_nav/1", "_root/1"], "…": "…" },
    "/[locale]/products/[id]":  { "fragments": ["_root/doc", "_root/0", "[locale]/_nav/0",
                                    "[locale]/products/[id]",
                                    "[locale]/_nav/1", "_root/1"],
                                  "cacheControl": "public, s-maxage=300, stale-while-revalidate=3600",
                                  "…": "…" },
    "/account/orders":          { "fragments": ["_root/doc", "_root/0", "account/orders", "_root/1"],
                                  "cacheControl": "private, no-store", "…": "…" },
    "/dashboard":               { "fragments": ["_root/doc", "_root/0", "dashboard/index", "_root/1"], "…": "…" },
    "/dashboard/settings":      { "fragments": ["_root/doc", "_root/0", "dashboard/settings", "_root/1"], "…": "…" },
    "/app":                     { "fragments": ["_root/doc", "_root/0", "app.island", "_root/1"], "…": "…" }
  },

  "fragments": {
    "_root/doc":                { "class": "route",  "queries": [], "pushes": [], "cacheControl": "…" },
    "_root/0":                  { "class": "route",  "queries": ["site-config"],
                                  "pushes": ["site-config"], "cacheControl": "…" },
    "_root/1":                  { "class": "route",  "queries": ["site-config"],
                                  "pushes": [], "cacheControl": "…" },
    "(home)":                   { "class": "static", "queries": [], "pushes": [], "cacheControl": "…" },
    "about":                    { "class": "static", "queries": [], "pushes": [], "cacheControl": "…" },
    "!404":                     { "class": "static", "queries": [], "pushes": [], "cacheControl": "…" },
    "[locale]/_nav/0":          { "class": "route",  "queries": ["nav"], "pushes": [],
                                  "cacheControl": "…",       // nav: no client consumer
                                  "prerender": { "inputs": ["param:locale"] } },
    "[locale]/_nav/1":          { "class": "route",  "queries": ["nav"], "pushes": [],
                                  "cacheControl": "…",
                                  "prerender": { "inputs": ["param:locale"] } },
    "[locale]/products/index":  { "class": "route",  "queries": ["product-list"], "pushes": [],
                                  "cacheControl": "…" },
    "[locale]/products/[id]":   { "class": "route",  "queries": ["product"], "pushes": ["product"],
                                  "cacheControl": "…",
                                  "prerender": { "inputs": ["param:locale", "param:id"] } },
    "account/orders":           { "class": "request", "queries": ["orders"], "pushes": [],
                                  "cacheControl": "…" },     // orders: no client consumer
    "dashboard/index":          { "class": "static", "queries": ["user-info"], "pushes": [],
                                  "cacheControl": "…" },     // cookies: never in bytes
    "dashboard/settings":       { "class": "static", "queries": ["user-info"], "pushes": [],
                                  "cacheControl": "…" },
    "app.island":               { "class": "static", "queries": [], "pushes": [], "cacheControl": "…" }
  },

  "queries": {
    "site-config":  { "url": "/api/site-config", "inputs": [] },
    "nav":          { "url": "/api/nav/{locale}", "inputs": ["param:locale"] },
    "product-list": { "url": "/api/products", "inputs": ["param:locale", "search:page"] },
    "product":      { "url": "/api/products/{locale}/{id}", "inputs": ["param:locale", "param:id"] },
    "orders":       { "url": "/api/orders", "inputs": ["cookies"] },
    "user-info":    { "url": "/api/user-info", "inputs": ["cookies"] }
  }
}
```

(`"…"` elides prebaked strings and asset lists for brevity; real files are
fully populated. `dashboard/settings` is `static` — frozen island bytes —
yet lists `user-info`: the query list drives announce/delivery
accounting, not rendering.)

`schema.json` carries the per-query contract for the Rust side and the
client: endpoint, inputs, derived cache class + prebaked `Cache-Control`
for the endpoint (§4.5), and the global prune set (§4.4):

```jsonc
{
  "product": {
    "url": "/api/products/{locale}/{id}",
    "inputs": ["param:locale", "param:id"],
    "cacheControl": "public, s-maxage=300, stale-while-revalidate=3600",
    "prune": ["name", "price"]            // union of usePageQuery lens paths
  },
  "user-info": {
    "url": "/api/user-info",
    "inputs": ["cookies"],
    "cacheControl": "private, no-store",
    "prune": ["name", "email"]
  }
  // …
}
```

### 13.4 Fragment files

A **template** (`route`-class, origin-executed):
`fragments/[locale]/products/[id].html`

```html
<article class="product">
  <h1>{{ product.name }}</h1>
  <p class="price">{{ product.price }}</p>
  {% for tag in product.tags %}<span class="tag">{{ tag }}</span>{% endfor %}
  <div data-island="products/[id]#0"><button disabled>Buy</button><script>
  (self._$HY=self._$HY||{r:{}}).r["i0"]="$$f"</script></div>
</article>
```

The island region (`BuyButton`) is frozen build bytes spliced into the
template (§4.2) — Jinja never touches it; it shows its serialized fallback
(`$$f`, §4.4) until hydration. Island markup/attribute details here are
illustrative; exact shapes are fixed by the island port (§11.3).

The **prerendered artifact** for `{locale: en, id: 42}`:
`html/_pacifica/en/products/42.html`

```html
<script>__pq.push(["q","product",{"name":"Rust Book","price":"$40"}])</script>
<article class="product">
  <h1>Rust Book</h1>
  <p class="price">$40</p>
  <span class="tag">books</span><span class="tag">systems</span>
  <div data-island="products/[id]#0"><button>Buy — $40</button></div>
</article>
```

Everything settled: substitution done, the island captured in its
**settled** state (covered query, §6.3), the push inlined at the start of
the fragment's bytes (§4.5) and pruned to `["name","price"]`. This file is
served verbatim by CDN or origin; the pushed data and the markup cannot
disagree (§6.4).

A **frozen island fragment** (`static`-class, uncovered query):
`html/_pacifica/dashboard/settings.html`

```html
<div data-island="dashboard/settings#0">
  <section><h2>Settings</h2><p>Loading profile…</p></section>
  <script>(self._$HY=self._$HY||{r:{}}).r["s0"]="$$f"</script>
</div>
```

No push — `user-info` is `cookies`-class, never build-resolvable. The
client fetches it on first read per the resolution rule (§4.5); the
fallback shows until the signal write lands (§4.4).

### 13.5 A hard navigation, origin-assembled: `GET /en/products/42`

Match walks the tree: `[locale]` binds `en`, `products` static, `[id]`
binds `42` → sequence `/[locale]/products/[id]` (§10.2). Headers copied
from the sequence entry. Then, per fragment in order (§10.4):

The origin stats the sequence's prerenderable fragments up front (it
needs the results for the announce), then, per fragment in order (§10.4):

| fragment | path checked | result |
|---|---|---|
| `_root/doc` | (never prerendered, §3.2) | execute template: splice `assetsHtml`; stub + **announce** ride here |
| `_root/0` | `html/_pacifica/_root/0.html` | hit (empty binding, §6.1) → bytes as-is (`site-config` push baked) |
| `[locale]/_nav/0` | `html/_pacifica/en/_nav/0.html` | hit → bytes as-is (no push: `nav` has no client consumer) |
| `[locale]/products/[id]` | `html/_pacifica/en/products/42.html` | hit → bytes as-is (`product` push baked) |
| `[locale]/_nav/1` | `html/_pacifica/en/_nav/1.html` | hit → bytes |
| `_root/1` | `html/_pacifica/_root/1.html` | hit → bytes (`pushes: []` — the render's push lives in `_root/0`, §4.5) |

The announce is the union of the served fragments' manifest `pushes` plus
anything the origin will run itself — here everything is baked, so:
`["site-config","product"]`. (Were an island on this route reading
`user-info`, the origin would run and push it too — full single-response
delivery, §4.5.)

Wire shape (structure, not literal bytes):

```html
<!doctype html><html><head>                    <!-- _root/doc: preamble (§3.2) -->
  <script>__pq=self.__pq||[]</script>          <!--   stub -->
  <script>__pq.push(["announce",["site-config","product"]])</script>
  <link rel="stylesheet" href="/static/products-D3ax.css">  <!-- assetsHtml spliced -->
</head><body>
<script>__pq.push(["q","site-config",{"theme":"dark"}])</script>  <!-- _root/0 (baked) -->
<header>…theme toggle island…</header><main>
<nav>…prerendered en nav…</nav>                                   <!-- en/_nav/0 -->
<script>__pq.push(["q","product",{"name":"Rust Book","price":"$40"}])</script>
<article class="product">…settled…</article>                      <!-- en/products/42 -->
<aside>…en nav footer…</aside>                                    <!-- en/_nav/1 -->
</main><footer>…</footer></body></html>                           <!-- _root/1 -->
```

The composed page `html/en/products/42/index.html` is this same byte
stream with the preamble baked at derivation (§6.5) — every fragment
here already has build-final bytes. When islands hydrate,
`usePageQuery(product, 'price')` and `usePageQuery(site-config, …)` hit
the cache and resolve synchronously (§4.5); nothing is fetched.

The user's root layout authored this preamble as plain JSX — Pacifica's
two templating systems in one file (§1): arbitrary build-time code plus
one substitution prop:

```tsx
export default function Root(props: { assets: JSX.Element }) {
  return (
    <html>
      <head>
        <meta charset="utf-8" />
        {props.assets}          {/* → {{ __pacifica.assets }} (§3.2) */}
      </head>
      <body>
        <header><ThemeToggle /></header>
        <main><Outlet /></main>
        <footer>…</footer>
      </body>
    </html>
  );
}
```

### 13.6 A hard navigation, CDN-served: `GET /dashboard/settings`

The CDN serves `html/dashboard/settings/index.html` (composed at build,
§13.2): preamble with baked announce `["site-config"]`, static shell,
`site-config` push, frozen-fallback island. When the settings island
hydrates, `usePageQuery(userInfo, …)` applies the resolution rule (§4.5):
no cache entry, **not announced** → fetch `/api/user-info` (private,
origin) right then. Signal write → fallback swaps to profile (§4.4). The
HTML never touched the origin; personalization happened anyway — and the
client never needed to know a CDN was involved.

### 13.7 A soft navigation: `/about` → `/en/products/42`

1. Sequence diff (§3.3): shared `_root/*`; needed: `[locale]/_nav/0`,
   `[locale]/products/[id]`, `[locale]/_nav/1`.
2. All three are prerender hits for `{locale: en, id: 42}` — PageRouter
   builds the substituted paths itself (same one encoding function, §6.5)
   and fetches `/_pacifica/en/_nav/0.html`, `/_pacifica/en/products/42.html`,
   `/_pacifica/en/_nav/1.html` from CDN, plus the route's CSS/JS from the
   manifest, in parallel.
3. Concatenate, swap inside `startViewTransition()`; re-create script
   elements from the fetched bytes so the `product` push and the island's
   `_$HY.r` script execute (§4.5).
4. Hydrate the entering BuyButton island; dispose nothing (none left).
5. The BuyButton's `usePageQuery(product, 'price')` resolves per the
   rule (§4.5): the `product` push arrived inside the prerendered
   artifact PageRouter itself fetched (its expected-push set, §3.3) —
   cache hit, done. Had the target been `{id: 99}` (uncovered), step 2
   would have fetched `[locale]/products/[id]` from the origin instead
   (lone-fragment render, push inlined) — same swap, same rules.
