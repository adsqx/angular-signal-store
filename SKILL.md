---
name: angular-signal-store
description: Use @adsq/angular-signal-store to build Angular state as a callable nested proxy: reads like store.user.name(), writes like store.user.name = 'Ada', with per-path signal wake, batching, and optional JSNQ queries over arrays. Use when writing or reviewing Angular components, services, or templates in a project that depends on @adsq/angular-signal-store, and when building live-editing UIs such as slider-driven design tools.
---

# @adsq/angular-signal-store

A reactive store for Angular built on a callable nested proxy. Calling a path (`store.user.name()`)
returns its value and, inside a template, `computed()` or `effect()`, subscribes to exactly that
path. Assigning to a path writes it and wakes only that path's consumers (and its parents). There
are no actions, reducers, selectors, or dispatch.

Install: `npm install @adsq/angular-signal-store`. Peers: `@angular/core` (20 to 22), `rxjs`, and
`@adsq/jsnq` (the core needs it at runtime; declare it too under pnpm or Yarn PnP).

## The architecture rule: read this first

**Build the entire application on the store, with no native signals of your own.** Do not create
`signal()` / `computed()` copies of data that already lives in the store, and do not keep a
parallel `signal()` next to a store path. A copy is a second source of truth: the store write
updates the proxy, the copy keeps the stale value, and the UI desyncs in a way that is hard to
trace.

State goes in the store. The template reads the store. Event handlers assign to the store. If a
component needs derived data, use `computed()` that *reads store paths*, never one that caches a
snapshot taken once.

```ts
import { computed, signal } from '@angular/core';
import { SignalStore } from '@adsq/angular-signal-store';

const store = new SignalStore(null).createStore<{ user: { name: string } }>({ user: { name: 'Ann' } }, 'rule');

// WRONG: a second source of truth that will drift
const nameCopy = signal(store.user.name());

// RIGHT: derives from the store on every read
const greeting = computed(() => `Hello ${store.user.name()}`);
```

## Where it is a particularly good fit

Live-editing interfaces where many small values change continuously and each one drives a
different piece of the DOM, such as design tools whose sliders modify appearance and style in real
time. A slider bound to `store.design.card.radius` wakes only the bindings that read that path.
The same applies to theme editors, layout inspectors, and property panels.

## Create the store

Create it once, in a root service. Declare state with `type`, never `interface` (an interface
fails the `Record<string, unknown>` constraint).

```ts
import { Injectable, inject } from '@angular/core';
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

  /** Same proxy typed as plain state: use it for assignments only. */
  readonly draft = this.store as unknown as AppState;
}
```

The service owns `this.store` and uses it directly. `createStore` throws if the name already
exists. Use `waitForStore` only in a consumer that may run before the owner creates the store:

```ts
import { SignalStore } from '@adsq/angular-signal-store';

const signalStore = new SignalStore(null);
type Dashboard = { tiles: number };

const pending = signalStore.waitForStore<Dashboard>('dashboard', { timeoutMs: 5_000 });
queueMicrotask(() => signalStore.createStore<Dashboard>({ tiles: 12 }, 'dashboard'));

const dashboard = await pending;
signalStore.useStore('dashboard');     // synchronous; throws when missing
signalStore.getStore('dashboard');     // the CreateStore instance (batch, wakeUp, array chain)
signalStore.destroyStore('dashboard'); // release it
```

## Read and write

Read through `store` with a call; write with an assignment. The declared type of a leaf is
callable, so under `strict` TypeScript rejects `store.user.name = 'Ada'`: assign through the
`draft` view. `setValue(path, value)` also writes but is not type-checked (any path and value
compile).

```ts
store.user.name();                                     // => 'Ann'
draft.user.name = 'Ada';                               // write
store.setValue('dashboard.tiles', 13);                 // also writes, but untyped
draft.dashboard.tiles = store.dashboard.tiles() + 1;
draft.user.tags.push('maintainer');
draft.user.preferences = {};                           // create a branch before its children
draft.user.preferences.theme = 'dark';
store.user.preferences?.theme?.();                     // => 'dark'
```

- **Missing paths read as `undefined`**, not as a callable. `store.user.preferences.theme()` throws
  until `preferences` exists. Initialise fields, create parents first, or guard with `?.`.
- **Assigning `undefined` deletes the key.** Use `null` for "no value".
- **Writes keep the reference you pass**, and `store.x()` returns a snapshot. After
  `draft.user = obj`, mutate through the proxy, never through `obj`.
- State keys must not contain `.`, and must not shadow a proxy member (`select`, `batch`,
  `setValue`, `mutate`, `query`, `pipeline`, `length` on arrays, `$`-prefixed names).

## In a template

Expose the proxy as a component field and read it directly. No `async` pipe, no `signal()`
wrapper, no subscription.

```ts
import { Component, inject } from '@angular/core';
import { AppStore } from './app.store';

@Component({
  selector: 'app-dashboard',
  template: `
    <h1>{{ store.user.name() }}</h1>
    <p>{{ store.dashboard.tiles() }} tiles, {{ store.history.length }} samples</p>

    @for (service of store.services(); track service.name) {
      <div class="row">
        <strong>{{ service.name }}</strong>
        <span>{{ service.rps }}</span>
      </div>
    }

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

Three rules cover every template:

1. **A leaf is called.** `{{ store.user.name() }}`. The call is the reactive read.
2. **An array is called to iterate it, and each item is a plain value.** Write
   `@for (service of store.services(); track service.name)` and then `{{ service.name }}` with
   **no parentheses on the item**. Items are snapshots, not nested accessors. This is the most
   common mistake.
3. **`length` is reactive without a call.** `{{ store.history.length }}`.

## Arrays

```ts
// push returns the new length, like Array#push
draft.services.push({ name: 'db', rps: 40 });   // => 2
draft.services.unshift({ name: 'edge', rps: 5 });
draft.services.sort((a, b) => b.rps - a.rps);
draft.services.pop();
draft.services.splice(1, 1);
store.services.length;                          // => 1
store.services[0].rps();                        // => 120
draft.services[0].rps = 6;                      // item leaf write
```

- Mutators (`push`, `pop`, `shift`, `unshift`, `splice`, `sort`, `reverse`) return what the native
  method returns and wake the array, its `length`, and shifted indices.
- Iterate the value, `store.services()`. `for...of` on the proxy itself throws.
- Derive with `computed(() => store.services().filter(...))`. The proxy's own `filter`, `find`,
  `map`, `some`, `every`, `includes`, `indexOf`, `reduce` return a **signal** at runtime (call the
  result), while the declarations describe plain `Array` methods, so prefer the `computed()` form.
- Typed, non-reactive helpers: `findInArray`, `updateArrayItemByFind`, `updateArrayItem`,
  `deleteFromArray`, `deleteByIndex`, `lengthOfArray`. Paths accept `services.0.rps` and
  `services[0].rps`.

## Batching and wake modes

```ts
store.batch(() => {
  draft.user.name = 'Ada';
  draft.dashboard.tiles = 16;
});
store.wakeUp('user.name', 'grained'); // exact path only
store.wakeUp('user.name', 'leaf');    // path plus its parent chain (default)
```

Data writes inside `batch()` are synchronous (`store.readStore(path)` sees them), but signal
notifications flush once after the outermost batch, including when the callback throws, so a
callable read (`store.x()`) of an already-consumed path is refreshed only then. `batch` returns the
callback's result. A single write needs no batch.

`wakeUp` invalidates a path without mutating data. Use it only after changing the underlying object
outside the proxy (for example through `returnStore()`).

| Mode | Paths dirtied | Use |
| --- | --- | --- |
| `grained` | Exact path only | Leaf consumers only. |
| `leaf` | Path plus parent chain | Default; container consumers refresh too. |

`exact` and `granular` are aliases of `grained`.

## Queries and bulk mutations (JSNQ)

The core does not load the query engine. Import the entry point once at bootstrap, or `mutate`,
`$query`, `$queryOne`, `$liveQuery` and `$liveQueryOne` throw an error naming the missing import.
Registration is synchronous, so there is no timing hazard.

```ts
import '@adsq/angular-signal-store/jsnq';
import { SignalStore } from '@adsq/angular-signal-store';
import where from '@adsq/jsnq/operators/where';
import update from '@adsq/jsnq/operators/update';

type User = { id: number; active: boolean; score: number };

// The bundled declarations omit these proxy methods; declare the ones you use.
interface Queryable<T> {
  mutate(...operators: unknown[]): T[];
  $query(...operators: unknown[]): T[];
  $queryOne(...operators: unknown[]): T | null;
  $liveQuery(...operators: unknown[]): () => T[];
  $liveQueryOne(...operators: unknown[]): () => T | null;
}

const signalStore = new SignalStore(null);
const store = signalStore.createStore<{ users: User[] }>({
  users: [{ id: 1, active: true, score: 0 }, { id: 2, active: false, score: 0 }],
}, 'users');
const users = store.users as unknown as Queryable<User>;

users.mutate(where('active', '===', true), update('score', (score: number) => score + 1));
const active = users.$query(where('active', '===', true));    // => [{ id: 1, active: true, score: 1 }]
const first = users.$queryOne(where('id', '===', 2));         // => { id: 2, active: false, score: 0 }
const live = users.$liveQuery(where('active', '===', true));  // callable; read in a template or computed
live().length;                                                // => 1
```

`$query` / `$queryOne` are snapshots (mutating operators inside them run on a copy). `mutate`
commits and returns the updated array. `$liveQuery` / `$liveQueryOne` return accessors that rerun
when the branch changes. Use `mutate` / `$query` for array-wide work instead of hand-rolled loops.

## RxJS

```ts
import { SignalStore } from '@adsq/angular-signal-store';

const store = new SignalStore(null).createStore<{ user: { name: string } }>({ user: { name: 'Ann' } }, 'rx');
const name$ = store.getObservable('user.name');                    // emits the current value first
const name = store.getComputed('user.name');                       // Signal<string>
const label$ = store.select(() => `Hi ${store.user.name()}`);      // read through `store`, not the callback argument
```

`select()` emits once, synchronously, when the outermost `batch()` ends, with the final value.

## Devtools

```ts
import { ApplicationConfig, inject, isDevMode, provideAppInitializer } from '@angular/core';
import { SignalStore } from '@adsq/angular-signal-store';
import { provideSignalStoreDevtools } from '@adsq/angular-signal-store/devtools';

export const appConfig: ApplicationConfig = {
  providers: [
    ...(isDevMode()
      ? [provideSignalStoreDevtools(), provideAppInitializer(() => inject(SignalStore).devActivation(true))]
      : []),
  ],
};
```

The provider alone emits nothing; `devActivation(true)` starts the event stream (`DevService.action$`).
The package ships the event bus, not a panel. Applications that never import `/devtools` do not
load it.

## Checklist when writing code against this store

- Never mirror store data into a `signal()`; read the store path instead.
- Call leaves (`store.a.b()`); do not call `@for` items (`item.field`).
- Read with `store`, assign with `draft`; never assign through the read-typed proxy.
- Declare state with `type`; create the store once, in a root service.
- Use `track` in `@for`; prefer a stable id over `$index` for reordered data.
- Reach for `batch()` only when several writes must be observed as one update.
- Import `@adsq/angular-signal-store/jsnq` once before using `mutate` / `$query`.
- Derive array data with `computed(() => store.items()...)`, not the proxy's query methods.
- Do not import from `dist/` or deep internal paths; use the documented entries only.
