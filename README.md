# @adsq/angular-signal-store

[![npm](https://img.shields.io/npm/v/@adsq/angular-signal-store)](https://www.npmjs.com/package/@adsq/angular-signal-store)
[![license: MIT](https://img.shields.io/npm/l/@adsq/angular-signal-store)](./LICENSE)

Signal-based state for Angular, exposed as a **callable nested proxy**. Reading a path is a
call, writing it is an assignment, and each path is its own Angular signal:

<!-- check: prelude=store run=false -->
```ts
store.user.name();              // read: in a template or computed(), this subscribes to user.name only
draft.user.name = 'Ada';        // write: wakes the consumers of user.name (and of its parents), nothing else
```

There are no actions, reducers, selectors, `async` pipes or manual subscriptions. Templates
read the store directly, event handlers assign to it, and Angular's signal graph does the rest.

- **Fine-grained by construction.** A path gets a signal the first time something reads it;
  writes bump that path and its ancestors, not its siblings.
- **Arrays that behave.** `push`, `splice`, `sort` and friends go through the proxy, and
  `store.items.length` is reactive without materialising the array.
- **Optional query engine.** Bulk `mutate` / `$query` / `$liveQuery` over arrays come from
  [`@adsq/jsnq`](https://github.com/adsqx/jsnq) through a separate `/jsnq` entry point that
  applications which do not query never load.
- **Small surface, peers only.** Angular, RxJS and `@adsq/jsnq` are peer dependencies, so
  the package never ships a second framework runtime.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Core concepts](#core-concepts)
- [In templates](#in-templates)
- [Arrays](#arrays)
- [Batching and wake modes](#batching-and-wake-modes)
- [Queries and bulk mutation with JSNQ](#queries-and-bulk-mutation-with-jsnq)
- [Named stores and async creation](#named-stores-and-async-creation)
- [RxJS and signal interop](#rxjs-and-signal-interop)
- [Devtools](#devtools)
- [TypeScript notes](#typescript-notes)
- [Performance](#performance)
- [API reference](#api-reference)
- [FAQ and troubleshooting](#faq-and-troubleshooting)
- [Compatibility](#compatibility)
- [Examples](#examples)
- [Use with AI coding agents](#use-with-ai-coding-agents)
- [Contributing and verification](#contributing-and-verification)
- [License](#license)

## Install

```sh
npm install @adsq/angular-signal-store
# or
bun add @adsq/angular-signal-store
```

| Peer dependency | Range | Notes |
| --- | --- | --- |
| `@angular/core` | `>=20.0.0 <23.0.0` | Angular 20, 21 and 22. |
| `rxjs` | `^6.5.3 \|\| ^7.4.0` | Used for `getObservable` and `select`. |
| `@adsq/jsnq` | `^0.2.0` | The core uses its small path engine, so it is always required at runtime. Its query pipeline is only loaded through the optional `/jsnq` entry. |

npm and bun install peers automatically. Under strict installers (pnpm, Yarn PnP) declare
`@adsq/jsnq` in your own `package.json` too, especially if you import JSNQ operators
directly.

## Quick start

Create the store once, in a root service, and expose it as a field:

```ts
import { Component, Injectable, inject } from '@angular/core';
import { SignalStore } from '@adsq/angular-signal-store';

type AppState = {
  user: { name: string; tags: string[]; preferences?: Record<string, unknown> };
  dashboard: { tiles: number };
  services: { name: string; rps: number }[];
  history: number[];
};

@Injectable({ providedIn: 'root' })
export class AppStore {
  readonly store = inject(SignalStore).createStore<AppState>({
    user: { name: 'Ann', tags: ['admin'] },
    dashboard: { tiles: 12 },
    services: [{ name: 'api', rps: 120 }],
    history: [],
  }, 'app');

  /** The store as plain, typed JSON: assignments compile and go through the store. */
  readonly draft = this.store.$draft;
}
```

Then read it straight from a standalone component template and assign from a handler:

<!-- check: prelude=none -->
```ts
import { Component, inject } from '@angular/core';
import { AppStore } from './app.store';

@Component({
  selector: 'app-dashboard',
  template: `
    <h1>{{ store.user.name() }}</h1>
    <p>{{ store.dashboard.tiles() }} tiles</p>
    <button (click)="addTile()">Add tile</button>
  `,
})
export class DashboardComponent {
  private readonly app = inject(AppStore);
  protected readonly store = this.app.store;

  addTile(): void {
    this.app.draft.dashboard.tiles = this.store.dashboard.tiles() + 1;
  }
}
```

Clicking the button re-renders the `{{ store.dashboard.tiles() }}` binding. The
`{{ store.user.name() }}` binding is not touched.

The rule to remember: **read through `store` with a call, write through `draft` (or any
assignment) without one.**

## Core concepts

A store is a named tree of plain data. `createStore(initial, name, options?)` clones the
initial value with `structuredClone` (unless `cloneInitialValue: 'none'`), registers the store
under `name`, and returns the root proxy. Every property you navigate to is another proxy that
is also callable.

| You write | What happens |
| --- | --- |
| `store.user.name()` | Returns the value. Inside `computed()`, `effect()` or a template it subscribes to the path `user.name`. |
| `store.user()` | Returns the whole branch. Treat it as a read-only snapshot. |
| `draft.user.name = 'Ada'` | Writes the value and wakes consumers of `user.name` and of its ancestors (`user`). |
| `draft.user.preferences = {}` | Creates or replaces a branch. Its descendants are woken too. |
| `draft.user.tags.push('x')` | Array mutation through the proxy. Wakes tag consumers, `length` and shifted indices. |
| `store.user.tags.length` | Reactive length, no call. |
| `delete draft.user.preferences` | Removes the key. Assigning `undefined` removes it as well. |

How it works, in one paragraph: each path lazily gets a version signal and a `computed` that
reads it. A call on the proxy reads that computed, so Angular tracks it like any other signal.
A write bumps the version of the written path and of each ancestor. Sibling paths keep their
versions, so their consumers stay asleep. Nothing is allocated for paths nobody touches.

Facts worth knowing early:

- **Missing paths read as `undefined`, not as a callable.** `store.user.preferences.theme()`
  throws a `TypeError` while `preferences` does not exist. Create parents first or guard with
  `store.user.preferences?.theme?.()`.
- **Writes keep the reference you pass.** After `draft.user = obj`, mutate through the proxy,
  not through `obj`; mutating `obj` directly bypasses the wake.
- **Keys are paths.** A key containing `.` is interpreted as a nested path, and unsafe names
  such as `__proto__` are rejected.
- **Whole-store reads.** The root proxy is not callable. `store.returnStore()` returns the
  live root object (mutating it directly does not wake anything; see `wakeUp`).

### Lazy creation

The initial data is cloned when `createStore` runs. Everything reactive around it is
demand-driven:

- nested proxies are created on first navigation;
- version signals and path computeds are created on first tracked read;
- RxJS `BehaviorSubject`s, array query memos and computed selections exist only once you use
  the API that needs them;
- proxy caches are size-bounded and array query memos are held through `WeakRef`;
- the query engine and devtools are separate entry points and are never loaded implicitly;
- named-store waiters exist only while code awaits a store.

## In templates

Expose the proxy as a component field and read it directly. No `async` pipe, no `signal()`
wrapper, no subscription.

<!-- check: prelude=none -->
```ts
import { Component, inject } from '@angular/core';
import { AppStore } from './app.store';

@Component({
  selector: 'app-overview',
  template: `
    <h1>{{ store.user.name() }}</h1>
    <p>{{ store.dashboard.tiles() }} tiles, {{ store.history.length }} samples</p>

    @for (tag of store.user.tags(); track tag) {
      <span class="tag">{{ tag }}</span>
    }

    @for (service of store.services(); track service.name) {
      <div class="row">
        <strong>{{ service.name }}</strong>
        <span>{{ service.rps }}</span>
      </div>
    }
  `,
})
export class OverviewComponent {
  protected readonly store = inject(AppStore).store;
}
```

Three rules cover every template:

1. **A leaf is called**: `{{ store.user.name() }}`. The call is the reactive read.
2. **An array is called to iterate it, and each item is a plain value**:
   `@for (service of store.services(); ...)` then `{{ service.name }}`, with no parentheses on
   the item. Items are snapshots, not nested accessors.
3. **`length` is reactive without a call**: `{{ store.history.length }}` tracks pushes and pops
   without materialising the array.

Give `@for` a stable `track` expression (an id, not `$index`, for data that is reordered).
Writes stay ordinary assignments, so an event handler is a one-liner.

## Arrays

<!-- check: prelude=store -->
```ts
// push returns the new length, like Array#push
draft.services.push({ name: 'db', rps: 40 });     // => 2
draft.services.unshift({ name: 'edge', rps: 5 }); // => 3
draft.services.sort((a, b) => b.rps - a.rps);     // api 120, db 40, edge 5
draft.services.pop();                             // removes 'edge'
draft.services.splice(1, 1);                      // removes 'db'

store.services.length;                            // => 1
store.services()[0].name;                         // => 'api'
store.services[0].rps();                          // => 120
draft.services[0].rps = 6;                        // write one item's leaf
store.services[0].rps();                          // => 6
```

- Mutators (`push`, `pop`, `shift`, `unshift`, `splice`, `sort`, `reverse`) return what the
  native method returns and wake the array, its `length`, and consumers of shifted indices
  (for example `rows[1].id()` after `rows.splice(0, 1)`).
- Iterate with `store.services()`. `for (const s of store.services)` on the proxy itself is
  not supported.
- Element paths work in strings too, with dot or bracket syntax:

<!-- check: prelude=store -->
```ts
store.setValue('services.0.rps', 7);
store.setValue('services[0].rps', 8);
store.services[0].rps();                        // => 8
```

### Derived array data

Derive from `store.services()` inside a plain Angular `computed()`. It is typed, and the
computed re-runs when any element changes:

<!-- check: prelude=store -->
```ts
const busy = computed(() => store.services().filter((s) => s.rps > 50));
const total = computed(() => store.services().reduce((sum, s) => sum + s.rps, 0));
```

The proxy also answers the read-only array methods `find`, `findIndex`, `filter`, `map`,
`some`, `every`, `includes`, `indexOf` and `reduce` directly, but **at runtime they return a
memoised signal**, not a value: `store.services.filter(fn)()`. The bundled declarations
describe them as the plain `Array` methods, so prefer the `computed()` form above in
TypeScript code.

### Typed array helpers

For imperative, non-reactive work the store exposes path-based helpers. They read the current
value once and do not subscribe:

<!-- check: prelude=store -->
```ts
store.findInArray('services', (s) => s.name === 'api');       // => { name: 'api', rps: 120 }
store.updateArrayItemByFind('services', (s) => s.name === 'api', { name: 'api', rps: 130 });
store.updateArrayItem('services', 0, { name: 'api', rps: 131 });
store.lengthOfArray('services');                              // => 1
store.deleteFromArray('services', (s) => s.rps === 0);
store.deleteByIndex('services', 0);
store.lengthOfArray('services');                              // => 0
```

A fluent chain is available on the store instance (`SignalStore#getStore(name)`):

<!-- check: prelude=store -->
```ts
import type { CreateStore } from '@adsq/angular-signal-store';

const instance = signalStore.getStore('app') as unknown as CreateStore<AppState>;
instance.array('services').push({ name: 'cache', rps: 9 }).sort((a, b) => a.rps - b.rps);
store.services.length;                                        // => 2
```

## Batching and wake modes

Each write notifies its consumers immediately. Wrap related writes in `batch()` when they must
be observed as one coherent update:

<!-- check: prelude=store -->
```ts
store.batch(() => {
  draft.user.name = 'Ada';
  draft.dashboard.tiles = 16;
});
store.user.name();                                // => 'Ada'
```

Data writes inside `batch()` are synchronous: `store.readStore(path)` and `returnStore()` see
them at once. Signal notifications are queued and flushed once after the outermost batch ends,
including when the callback throws, so a callable read (`store.x()`) of a path that is already
being consumed returns its previous value until then. Batches nest, and `batch()` returns the
callback's result. A single write needs no batch.

`batch()` lives on the root proxy and on the instance returned by `signalStore.getStore(name)`.

### Manual wake

`wakeUp(path, mode)` invalidates a path **without** mutating data. Use it when you changed
the underlying object outside the proxy (for example through `returnStore()`, or a shared
object with `cloneInitialValue: 'none'`) and consumers must re-read:

<!-- check: prelude=store -->
```ts
store.wakeUp('user.name', 'grained'); // exact path only
store.wakeUp('user.name', 'leaf');    // path plus its parent chain (the default)
```

| Mode | Paths dirtied | Use case |
| --- | --- | --- |
| `grained` | Exact requested path only | Leaf consumers only. |
| `leaf` | Requested path plus its parent chain | Default; container consumers refresh too. |

`exact` and `granular` are aliases of `grained`. (The type also accepts two legacy
misspellings, `graied` and `graned`; do not use them.) `wakeup` is a lowercase alias of
`wakeUp`.

The store option `dependencyMode: 'exact' | 'container'` is separate from explicit wakes: it
decides whether tracked reads depend on the exact path (`exact`, the default) or on the parent
container (`container`, coarser). In `container` mode a development-time warning is logged when
very broad dependencies are detected.

## Queries and bulk mutation with JSNQ

JSNQ is a **separate entry point**. Import it once during application bootstrap to enable
`mutate`, `$query`, `$queryOne`, `$liveQuery` and `$liveQueryOne`:

```ts
import '@adsq/angular-signal-store/jsnq';
```

Registration is synchronous: there is no dynamic `import()` and nothing to await, so a mutation
issued immediately after bootstrap works. Calling a JSNQ method without the import throws an
error that names the missing entry point. Applications that only read and write paths never
load the query engine (see [Performance](#performance) for the measured size).

```ts
import '@adsq/angular-signal-store/jsnq';
import { SignalStore } from '@adsq/angular-signal-store';
import where from '@adsq/jsnq/operators/where';
import update from '@adsq/jsnq/operators/update';

type User = { id: number; name: string; active: boolean; score: number };

// The bundled declarations do not include these proxy methods yet; declare what you use.
interface Queryable<T> {
  mutate(...operators: unknown[]): T[];
  $query(...operators: unknown[]): T[];
  $queryOne(...operators: unknown[]): T | null;
  $liveQuery(...operators: unknown[]): () => T[];
  $liveQueryOne(...operators: unknown[]): () => T | null;
}

const signalStore = new SignalStore(null);
const store = signalStore.createStore<{ users: User[] }>({
  users: [
    { id: 1, name: 'Ann', active: true, score: 1 },
    { id: 2, name: 'Bob', active: false, score: 2 },
  ],
}, 'users');
const users = store.users as unknown as Queryable<User>;

users.mutate(where('active', '===', true), update('score', (score: number) => score + 1));

const active = users.$query(where('active', '===', true));   // => [{ id: 1, name: 'Ann', active: true, score: 2 }]
const bob = users.$queryOne(where('id', '===', 2));          // => { id: 2, name: 'Bob', active: false, score: 2 }
const liveActive = users.$liveQuery(where('active', '===', true));
liveActive().length;                                         // => 1
```

- `mutate(...operators)` applies mutating operators (`update`, `insert`, `deleteElement`, ...)
  copy-on-write, commits the result to the store, and returns the updated branch.
- `$query` / `$queryOne` read a one-shot snapshot. Mutating operators inside them run on an
  isolated copy and never touch the store.
- `$liveQuery` / `$liveQueryOne` return callable accessors that re-run when the queried
  branch changes. Read them inside `computed()`, `effect()` or a template.
- `query(...operators)` and `pipeline(...operators)` return a builder with `.all()`,
  `.first()` and `.count()` that yields signals of raw result nodes (`{ data, path, depth }`).
  Prefer the `$` methods, which return plain matched values.
- The JSNQ methods work on any array path, including nested ones (`store.a.b.$query(...)`).

Operators are individual imports from `@adsq/jsnq` (`@adsq/jsnq/operators/<name>` or the
package root). JSNQ is versioned separately; see its documentation for the operator reference.

## Named stores and async creation

`createStore` registers the store under its name, and the registry lives on the `SignalStore`
service:

<!-- check: prelude=store -->
```ts
signalStore.useStore('app');     // synchronous; throws when the store does not exist
signalStore.getStore('app');     // the store instance (batch, wakeUp, array chain), or undefined
signalStore.destroyStore('app'); // release resources and remove the name
```

Creating a store under a name that already exists throws (`Store 'app' already exists. Use
useStore('app') instead ...`), so create it once, in a root service.

When a service owns `this.store`, use that reference directly. Use `waitForStore` only across an
asynchronous ownership boundary, where a consumer may run before the code that creates the
store:

<!-- check: prelude=none -->
```ts
import { SignalStore } from '@adsq/angular-signal-store';

const signalStore = new SignalStore(null);
type Dashboard = { tiles: number };

const abort = new AbortController();
const pending = signalStore.waitForStore<Dashboard>('dashboard', {
  timeoutMs: 5_000,
  signal: abort.signal,
});

queueMicrotask(() => signalStore.createStore<Dashboard>({ tiles: 12 }, 'dashboard'));

const dashboard = await pending;
dashboard.tiles();   // => 12
```

`waitForStore` resolves immediately when the store already exists, is event-driven (no
polling), rejects with an `Error` on timeout and with an `AbortError` on abort, and removes
its timer and listener on every completion path.

## RxJS and signal interop

Every path is already an Angular signal, so `computed`, `effect` and `toObservable` work with
it. Beyond that, the store offers RxJS entry points:

<!-- check: prelude=store -->
```ts
const seen: string[] = [];
const subscription = store.getObservable('user.name').subscribe((name) => seen.push(name)); // emits the current value first
const tiles = store.getComputed('dashboard.tiles');                                          // Signal<number>
const label$ = store.select(() => `${store.user.name()} (${store.dashboard.tiles()})`);      // Observable<string>

draft.user.name = 'Ada';
seen;                                                                                        // => ['Ann', 'Ada']
tiles();                                                                                     // => 12
subscription.unsubscribe();
```

<!-- check: prelude=store run=false -->
```ts
import { toSignal } from '@angular/core/rxjs-interop';

const label = toSignal(store.select(() => store.user.name()), { requireSync: true });
```

- `getObservable(path)` is backed by a `BehaviorSubject` created on first use.
- `getComputed(path)` returns the path's `Signal`.
- `select(project)` returns an `Observable` that emits the projection's current value on
  subscribe and again whenever a path read inside `project` changes (compared with
  `Object.is`). The watcher exists only while there are subscribers. Read through the store
  variable inside `project`, as above.
- `computedOf(project)` is the same projection as an Angular `Signal`; a plain
  `computed(() => ...)` is equivalent and preferred.
- At runtime nested proxies also expose `subscribe(...)` and `pipe(...)`
  (`store.user.name.pipe(map(...))`); they are not in the type declarations, so use
  `getObservable` from TypeScript.

Known limitation in this release: `select()` subscribers do not re-emit for writes made inside
`batch()`. Signals and `getObservable` are unaffected.

## Devtools

The devtools adapter is a separate entry point. The main entry holds only the injection token
and the adapter types, so applications that never import `/devtools` never load it.

```ts
import { ApplicationConfig, inject, isDevMode, provideAppInitializer } from '@angular/core';
import { SignalStore } from '@adsq/angular-signal-store';
import { provideSignalStoreDevtools } from '@adsq/angular-signal-store/devtools';

export const appConfig: ApplicationConfig = {
  providers: [
    ...(isDevMode()
      ? [
          provideSignalStoreDevtools(),
          provideAppInitializer(() => inject(SignalStore).devActivation(true)),
        ]
      : []),
  ],
};
```

`provideSignalStoreDevtools()` binds the `SIGNAL_STORE_DEVTOOLS` token to `DevService`, an
event bus. **Events flow only while devtools are active**: call `devActivation(true)` (or
`bindDevActivation(active$)`). Consume the events from `DevService`:

<!-- check: prelude=none -->
```ts
import { SignalStore } from '@adsq/angular-signal-store';
import { DevService } from '@adsq/angular-signal-store/devtools';

const devtools = new DevService();
const signalStore = new SignalStore(devtools);
signalStore.devActivation(true);

devtools.action$.subscribe((event) => {
  if (event) console.log(event.type, event.storeName, event.payload);
});
```

- `action$` is the live stream; `readAction$` is the history stream. Both are
  `BehaviorSubject`-backed, so they emit `null` first. Proxy-cache metrics (`PROXY_METRICS`)
  go only to `action$`.
- Event types: `SET_VALUE`, `SET_VALUE_OBSERVE`, `ARRAY_OPERATION`, `COMPUTED_STORE_UPDATE`,
  `BEHAVIOR_STORE_UPDATE`, `VERSION_STORE_UPDATE`, `PROXY_METRICS`, `UNSUBSCRIBE`, `CLEANUP`.
- This package ships the event bus, not a panel. A UI is up to you; `enableDevTools(name)`
  only appends an `<app-dev-tools>` element to the document (browser only); the component that
  renders it is not part of this package.
- Use `setMetricsThrottle(ms)` or the `metricsThrottleMs` store option to throttle metrics.

## TypeScript notes

The declarations describe reads and path-based APIs precisely, and are loose or silent about
a few proxy-only behaviours. Know these edges:

**State can be a `type` or an `interface`.** `createStore<T extends object>` accepts both.

**Reads are typed.** `store.user.name()` is `string`, `store.services()` is the element array,
`store.services.length` is `number`, and `@for` items are typed.

**Write like plain JSON with `$draft`.** A leaf's declared type is callable
(`string & (() => string)`), so `store.user.name = 'Ada'` does not compile under `strict`.
`store.$draft` is the same store typed as plain, deep-mutable data (`Draft<AppState>`):

<!-- check: prelude=store-bare -->
```ts
const draft = store.$draft;

draft.user.name = 'Ada';
draft.user.tags.push('maintainer');
draft.dashboard.tiles = draft.dashboard.tiles + 1;
draft.services.find((s) => s.name === 'api')!.rps = 90; // elements are drafts too
```

Every write through `$draft` takes the store's normal write path (same precise wakes, same
devtools events), and array mutators call the store's array methods. Reads through `$draft`
return the current plain values **without** subscribing anything: use `store.x()` for reactive
reads in templates and computeds, `$draft` for typed writes and imperative reads.
`CreateStore#draft` is the same view. `store.setValue('user.name', 'Ada')` also writes, but it is
not type-safe: a fallback overload accepts any path and any value.

**Reads infer from literal paths.** `store.getComputed('dashboard.tiles')` is `Signal<number>` and
`store.readStore('user.name')` is `string | undefined`. Path arguments are autocompleted from
your state type, but a mistyped path still compiles (its value type is `unknown`).

**Other edges**

| Situation | What to do |
| --- | --- |
| `useStore(name)` returns `StoreProxy<StoreData>` | Cast: `signalStore.useStore('app') as unknown as StoreProxy<AppState>`. `waitForStore<AppState>()` is typed. |
| `getStore(name)` returns `CreateStore<StoreData>` | Cast to `CreateStore<AppState>` (through `unknown`) for typed array chains. |
| `mutate`, `$query`, `$liveQuery`, ... are not declared | Declare the `Queryable<T>` interface shown above. |
| Optional or dynamic keys | Declare `preferences?: Record<string, unknown>` (or an index signature) and guard reads with `?.`. |

## Performance

The repository ships a micro-benchmark, `test/store-throughput-bench.ts`. It measures the raw
proxy layer: it turns read tracking and behavior updates off and has no reactive consumers,
so it shows how much the proxy costs per operation, not end-to-end render time.

Measured on this repository revision, on a shared 4 vCPU Intel Xeon @ 2.80 GHz VM (Linux 6.18),
running `bun 1.3.11`. The script itself reports the median of 5 rounds; the figures below are
the **median of 11 separate runs** of the script (host load average 2.3 to 4.1 while running,
so absolute numbers are conservative). A second set of 9 runs earlier the same day agreed with
these medians within 3%.

| Case (one operation = one proxy call) | Median ops/s | Median ns/op | Min to max ops/s |
| --- | ---: | ---: | ---: |
| Deep read, full navigation: `store.user.profile.name()` | 2.51 M | 398 | 2.20 M to 2.69 M |
| Deep write, full navigation: `store.user.profile.name = v` | 960 k | 1,041 | 804 k to 1,120 k |
| Deep write, cached parent proxy: `profile.name = v` | 1.12 M | 895 | 981 k to 1.25 M |
| `push` + `pop` on a 100-element array, full navigation | 428 k | 2,334 | 378 k to 475 k |
| `push` + `pop`, cached array proxy | 490 k | 2,041 | 371 k to 537 k |
| Three writes inside one `batch()` (per write) | 494 k | 2,025 | 414 k to 585 k |

Holding on to a sub-proxy (`const profile = store.user.profile`) skips repeated navigation: in
this benchmark the cached-parent write and the cached-array `push`/`pop` were about 13 to 14%
faster than their full-navigation counterparts. These numbers say nothing about Angular
change-detection cost, which depends on your templates.

Reproduce:

```sh
bun test/store-throughput-bench.ts   # or: npm run bench:store
```

Bundle size, measured on this revision from the ng-packagr output with esbuild
(`--bundle --minify`, `@angular/*` and `rxjs` external):

| Entry | Minified | Gzip | Brotli |
| --- | ---: | ---: | ---: |
| Core (`@adsq/angular-signal-store`, `@adsq/jsnq` external) | 57.6 kB | 17.4 kB | 15.8 kB |
| Core including the `@adsq/jsnq` path engine it uses | 63.4 kB | 19.5 kB | 17.6 kB |
| Adding the `/jsnq` entry (query pipeline engine) | +47.6 kB | +15.5 kB | +13.7 kB |
| Adding the `/devtools` entry | +3.8 kB | +0.8 kB | +0.7 kB |

Applications that do not import `/jsnq` or `/devtools` do not pay for them. From RxJS the core uses
only `BehaviorSubject`, `Observable` and `Subscription`, which `@angular/core` already loads.

## API reference

Everything below is exported from the entry points listed, or reachable from the objects
they return. "Root proxy" means the value returned by `createStore` / `useStore`.

### Entry points

| Entry | Exports |
| --- | --- |
| `@adsq/angular-signal-store` | `SignalStore` (also the default export), `CreateStore`, `SIGNAL_STORE_DEVTOOLS`, types `StoreProxy`, `Draft`, `WaitForStoreOptions`, `AngularStoreDevtools`, `DevToolsEvent`, and the `Signal` type re-exported from Angular. |
| `@adsq/angular-signal-store/jsnq` | Side effect: registers the query engine. Also exports `angularJsnqBridge` (the registered bridge object). |
| `@adsq/angular-signal-store/devtools` | `provideSignalStoreDevtools()`, `DevService`, types `AngularStoreDevtools`, `DevToolsEvent`. |

### `SignalStore` (root service)

Injectable, `providedIn: 'root'`. The constructor takes an optional `AngularStoreDevtools`
(injected from `SIGNAL_STORE_DEVTOOLS`); `new SignalStore(null)` works without Angular DI.

| Group | Member | Description |
| --- | --- | --- |
| Create | `createStore<T>(initial, name, options?)` | Creates and registers a store; returns `StoreProxy<T>`. Throws on an empty or duplicate name. |
| Lookup | `useStore(name)` | The proxy. Throws when the store does not exist. |
| | `waitForStore<T>(name, { timeoutMs?, signal? })` | `Promise<StoreProxy<T>>`; resolves when the store is created. |
| | `getStore(name)` | The `CreateStore` instance, or `undefined`. |
| Lifecycle | `destroyStore(name)` / `removeStore(name)` | Clears caches, timers and the registry entry. |
| One-shot reads | `read(name, path)`, `readStore(name, path)`, `getSignalValue(name, path)` | Non-reactive read of a raw path value. |
| | `select(name, selector)` | Non-reactive typed read: `selector(rootValue)`. Not the same as `store.select`. |
| Legacy write | `setValue(name, path, value)` | Writes a path and wakes it. Prefer the proxy. |
| Devtools | `devActive`, `devActivation(active)`, `bindDevActivation(active$)` | Toggle event emission (`bindDevActivation` returns a `Subscription`). |
| | `attachDevtools(adapter \| null)`, `getDevtoolsAdapter()` | Replace or read the adapter. |
| | `devAction$`, `devReadAction$` | The adapter's streams, or `EMPTY` without one. |
| | `emitDevAction`, `emitDevReadAction`, `emitProxyMetrics`, `setMetricsThrottle(ms)` | Emission helpers used by the library. |
| Proxy cache | `setProxyCacheLimit(name, n)`, `getProxyCacheLimit(name)`, `clearProxyCacheLimit(name)` | Per-store proxy cache size. |
| Advanced | `registerStoreInstance(name, instance)`, `createCallableProxy(path, instance, value)` | Used when constructing a `CreateStore` directly. |

### `createStore` options

| Option | Default | Effect |
| --- | --- | --- |
| `dependencyMode` | `'exact'` | `'exact'` tracks the exact path; `'container'` tracks the parent container. |
| `cloneInitialValue` | clone | Any value except `'none'` `structuredClone`s the initial data. `'none'` uses the object you pass. |
| `strict.invalidPath` | off | Throw (instead of warning) when a proxy write or delete targets an invalid path. |
| `strict.deleteUndefined` | off | Throw when a write assigns `undefined` or a key is deleted. |
| `strict.rootRxjs` | off | Throw when `pipe`/`subscribe` is used on the root proxy while `rxjsAllowedOnRoot` is `false`. |
| `rxjsAllowedOnRoot` | `true` | Allow `pipe`/`subscribe` on the root proxy. |
| `proxyCacheMaxSize` | `1000` | Size of the proxy cache. |
| `metricsThrottleMs` | `250` | Devtools metrics throttle; applies to the whole `SignalStore`. |
| `useInPlaceIteration` | `false` | Read dot paths without splitting them. |
| `versionBump.partialInvalidation` | `false` | Wake only the exact written path, not its ancestors. Container consumers then go stale; opt in deliberately. |
| `versionBump.strategy`, `versionBump.throttleMs` | `'microtask'`, `0` | Scheduling of deferred version flushes (`'microtask'` or `'raf'`). |

### Root proxy and `CreateStore` methods

The root proxy exposes the methods below. `CreateStore` (what `getStore` returns) has the same
methods plus `array()`, `destroy()` and tuning setters.

| Group | Method | Description |
| --- | --- | --- |
| Read | `readStore(path)`, `getSignalValue(path)` | Non-reactive read by path. |
| | `returnStore()` | The live root data object. Do not mutate it without `wakeUp`. |
| Reactive | `getComputed(path)` | `Signal` for the path. |
| | `getObservable(path)`, `getBehaviorSubject(path)` | RxJS view of the path. |
| | `select(project)`, `computedOf(project)` | Observable / Signal projection with dependency tracking. |
| Write | `draft` | Same view as `store.$draft`: plain, typed JSON whose writes go through the store. |
| | `setValue(path, value)`, `setValueObserve(path, value)` | Write a path. Throws on an invalid path. |
| | `deleteValue(path)` | Remove a key. |
| | `batch(fn)` | Group writes; returns `fn`'s result. |
| | `wakeUp(path, mode?)`, `wakeup` | Manual invalidation. Modes `leaf` (default), `grained`. |
| Array (path-based) | `setArrayMethod(path, value, method, ...args)` | Run a mutator by name (`push`, `pop`, `shift`, `unshift`, `splice`, `sort`, `reverse`). |
| | `queryArray(path, value, method, ...args)` | Run a query by name; also `'length'`. |
| | `findInArray`, `findIndexInArray`, `filterArray`, `mapArray`, `reduceArray`, `someArray`, `everyArray`, `includesInArray`, `indexOfInArray`, `lengthOfArray` | Typed non-reactive queries. |
| | `updateArrayItem(path, index, value)`, `updateArrayItemByFind(path, predicate, value)` | Replace an element. |
| | `deleteFromArray(path, predicate)`, `deleteByIndex(path, index)` | Remove elements. |
| Housekeeping | `cleanupPath(path)` | Drop derived resources under a path. |
| | `enableDevTools(name, showVisualizer?)` | Devtools hook; see [Devtools](#devtools). |
| Instance only | `array(path)` | Fluent chain: `push`, `unshift`, `pop`, `shift`, `sort`, `splice`, `update`, `updateByFind`, `delete`, `deleteByIndex`, `find`, `findIndex`, `filter`, `map`, `reduce`, `some`, `every`, `includes`, `indexOf`, `length`. |
| | `destroy()` | Prefer `signalStore.destroyStore(name)`. |

Also declared, but internal plumbing rather than day-to-day API: `addToComputeStore`,
`deleteFromComputeStore`, `updateBehaviorsBySegments`, `behaviorStore`, `computedStore`,
`devService`, `prefetchCursorWithNode`, `setValueFast`, `setArrayMethodRef`.

### Proxy node surface

Available on every nested proxy (`store.a.b`):

| Member | Behavior |
| --- | --- |
| `node()` | Reactive read of the value. |
| `node = value` / `delete node` | Write / remove. `undefined` removes. |
| `node.length` | Reactive length of an array. |
| `push`, `pop`, `shift`, `unshift`, `splice`, `sort`, `reverse` | Array mutators. |
| `find`, `findIndex`, `filter`, `map`, `some`, `every`, `includes`, `indexOf`, `reduce` | Array queries; return memoised signals. |
| `node[0]`, `node.child` | Child proxy (or `undefined` if the path does not exist). |
| `$val`, `$signal` | Current value (untracked) / path signal, on every node. |
| `store.$draft` | The whole store as plain, typed JSON (`Draft<T>`): typed writes through the store, untracked reads. |
| `mutate`, `$mutate` | JSNQ mutation (needs `/jsnq`). |
| `$query`, `$queryOne`, `$liveQuery`, `$liveQueryOne` | JSNQ reads (need `/jsnq`). |
| `query`, `pipeline` | JSNQ builders returning signals of result nodes (need `/jsnq`). |
| `pipe`, `subscribe` | RxJS view of the node (runtime only, not declared). |

A state key with the same name as one of these members, or, on the root, as one of the root
methods (`select`, `batch`, `setValue`, `array`, ...), is shadowed by the member. Rename the key.

### Devtools contract

`AngularStoreDevtools`: `action$`, `readAction$` (`Observable<DevToolsEvent | null>`),
`emitAction(event)`, `emitRead(event)`, `getBehaviorKeys(store)`, `getComputedKeys(store)`.
`DevToolsEvent` is a devtools action plus an optional `storeName`. `DevService` implements the
contract as a `BehaviorSubject` bus with additional typed emit helpers.

## FAQ and troubleshooting

**`TypeError: ... is not a function` or `Cannot read properties of undefined` on a read.**
The path does not exist. Missing paths are `undefined`, not callables. Create the parent
first (`draft.user.preferences = {}`), initialise the field, or guard with `?.`.

**`service.name is not a function` (or a compile error) inside `@for`.** Items of
`store.services()` are plain values. Write `service.name`, not `service.name()`.

**`store.services.filter(...)` gives me a function.** Array query methods on the proxy return
memoised signals. Call the result, or use `computed(() => store.services().filter(...))`.

**`for (const s of store.services)` throws "not iterable".** Iterate the value:
`for (const s of store.services())`.

**`Type 'string' is not assignable to type 'string & (() => string)'`.** Leaves are typed as
callables. Assign through a write view or use `setValue`; see [TypeScript notes](#typescript-notes).

**`mutate() needs the JSNQ integration. Import '@adsq/angular-signal-store/jsnq' ...`.**
Add `import '@adsq/angular-signal-store/jsnq';` once at bootstrap.

**`Store 'app' already exists`.** `createStore` was called twice with one name (often a
component or test re-creating it). Create the store in a root service, call `useStore(name)`
elsewhere, and `destroyStore(name)` between tests.

**My state key does nothing / returns a function.** It collides with a proxy member or a root
method (`select`, `batch`, `mutate`, `query`, `pipeline`, `length` on arrays, ...). Rename it.
Keys containing `.` are read as nested paths.

**I mutated an object and nothing re-rendered.** The store only wakes writes that go through
the proxy. After `draft.user = obj`, changing `obj` (or an object returned by `store.user()`)
bypasses it. Mutate through the proxy, or call `wakeUp(path)` after an out-of-band change.

**Assigning `undefined` removed the key.** That is by design: `undefined` deletes. Use `null`
for "no value", or set `strict: { deleteUndefined: true }` to make it throw.

**`store.x()` returned the old value inside `batch()`.** Callable reads refresh when the
outermost batch ends. Read `store.readStore('x')` when you need the fresh value mid-batch.

**Devtools show nothing.** Providing `provideSignalStoreDevtools()` is not enough; call
`signalStore.devActivation(true)`. The package ships the event bus, not a panel.

**`select()` inside `batch()`.** A selector whose inputs change inside `batch()` emits once,
synchronously, when the outermost batch ends, with the final value.

## Compatibility

- **Angular** `>=20.0.0 <23.0.0`. This repository builds and runs its checks against Angular
  20.3, the lowest supported line; 21 and 22 are covered by the peer range.
- **Package format.** Angular Package Format with **partial compilation**
  (`compilationMode: partial`), compiled against the lowest supported Angular. Your
  application's Angular linker finishes compilation with your own Angular version, which keeps a
  single framework runtime and forward-linker compatibility.
- **Reactivity.** Path reads are ordinary Angular `computed` signals and the package has no
  `zone.js` dependency.
- **RxJS** `^6.5.3 || ^7.4.0`, **TypeScript** declarations built with 5.8.
- **Module format.** ESM only (`"type": "module"`, exports map with `.`, `./jsnq`,
  `./devtools`). `sideEffects` marks only the `/jsnq` entry, so bundlers keep its registration
  import.

## Examples

`examples/` contains short, runnable, headless TypeScript examples (basic store, arrays,
JSNQ queries, named stores with `waitForStore`, and devtools). They run under `bun` with no
browser:

```sh
npm run examples
```

See [`examples/README.md`](./examples/README.md).

## Use with AI coding agents

The package ships a `SKILL.md` written in the [Agent Skills](https://agentskills.io) format,
covering the architecture rule, the template rules, batching, wake modes and JSNQ. Install it
so an agent applies the store correctly instead of guessing at the proxy API:

```sh
# this project only
mkdir -p .claude/skills/angular-signal-store
cp node_modules/@adsq/angular-signal-store/SKILL.md .claude/skills/angular-signal-store/

# or for every project
mkdir -p ~/.claude/skills/angular-signal-store
cp node_modules/@adsq/angular-signal-store/SKILL.md ~/.claude/skills/angular-signal-store/
```

Claude Code picks the skill up without a restart and loads it when the task involves this
store. Agents that do not read `.claude/skills/` can be pointed at
`node_modules/@adsq/angular-signal-store/SKILL.md` directly. Contributors: see
[`AGENTS.md`](./AGENTS.md).

## Contributing and verification

```sh
npm run typecheck          # tsc --noEmit
npm run test:smoke         # headless smoke (bun)
npm run test:jsnq-optional # the /jsnq entry is genuinely optional
npm run examples           # all runnable examples
npm run typecheck:examples # tsc over examples/
npm run build              # ng-packagr
npm pack --dry-run         # inspect the tarball
```

## License

MIT
