# v2_new: immutable-core prototype of the Angular store

A prototype of the store on a different core, kept next to the current one for comparison. **The
published library (`src/`) is unchanged**; nothing in this folder is built, packed or published.

```sh
bash v2_new/compare.sh      # tests, benchmarks, bundle size and the stale-read check, current vs v2
bash v2_new/run-compat.sh   # only the current test suites and examples, run against v2
```

## The idea

The writing style stays the same: `store.a.b = x`, `list.push(...)`, `$draft`, `mutate(where(...),
update(...))`. Underneath, the data is immutable:

- One root signal holds the data. Every path is `computed(() => parent()[key])`, so Angular's own
  equality check wakes exactly the branches whose reference changed. There are no version signals,
  ancestor bumps, wake modes, scheduler, proxy-cache invalidation or write cursor.
- A write copies the path from the root to the target (structural sharing).
- **Copy only when someone has seen it.** A copy made by a write stays editable in place until the
  data is observed: a computed reads it, or a read hands out a reference (`readStore`, `$val`,
  subscriptions, devtools). Only the next write after an observation copies again. A loop of
  writes with no reads in between therefore costs the same as in-place mutation, and `batch()`
  produces one root change.

Sources: `src/core.ts` (data, signals, writes), `src/proxy.ts`, `src/create-store.ts`,
`src/signal-store.ts`, `src/arrays.ts`, `src/draft.ts`, `src/jsnq.ts` (optional entry).

## Results (this machine; rerun `compare.sh` on yours)

### Compatibility

The current test suites and examples, unchanged, run against v2:

| Suite | Result |
| --- | --- |
| `test/smoke.ts` | passes |
| `test/regressions.test.ts` | 7,933 / 7,933 checks pass (1 check that counts the current store's internal version nodes does not apply) |
| `test/draft.test.ts` | passes |
| `test/jsnq-optional.test.ts` | passes |
| `examples/01`-`05` | all 5 pass (v2 ships its own `/devtools` entry with the same `DevService`) |

Not covered yet: the type-level contract tests (`types-proxy-contract.ts`, `draft-types.ts`). The
prototype's public types are loose (`createStore` returns `any`); the current typings would be
ported as is.

### Bundle size (esbuild, minified; Angular and RxJS external)

| Bundle | Minified | Gzip | Brotli |
| --- | ---: | ---: | ---: |
| current: core + the jsnq path engine it uses | 63.0 kB | 19.3 kB | 17.4 kB |
| **v2: core + the jsnq path engine it uses** | **20.3 kB** | **7.1 kB** | **6.5 kB** |
| current: core + `/jsnq` entry (queries) | 110.4 kB | 34.8 kB | 31.2 kB |
| v2: core + `/jsnq` entry (queries) | 69.9 kB | 23.2 kB | 21.0 kB |

### Throughput (`test/store-throughput-bench.ts`, ms, median of 5; lower is better)

| Case | Current | v2 |
| --- | ---: | ---: |
| deep read, full navigation (500k) | 163 | 154 |
| deep write, full navigation (200k) | 164 | 215 |
| deep write, cached parent (200k) | 149 | 174 |
| push + pop, full navigation (100k) | 462 | 226 |
| push + pop, cached node (100k) | 412 | 210 |
| three writes in a batch (100k) | 510 | 249 |

### Scenarios sensitive to the immutable core (`bench-extra.ts`, ms; lower is better)

| Scenario | Current | v2 |
| --- | ---: | ---: |
| push x10k into a 10k array, no batch | 27 | 34 |
| push x10k into a 10k array, one batch | 16 | 14 |
| worst case: push + tracked read x2k, 10k array | 167 | 143 |
| update 1k items by index, no batch | 6.5 | 5.2 |
| write 1k keys of a 1k-key object | 5.4 | 3.7 |
| 1k computeds on items, write one item x1k | 1231 | 338 |
| deep read x200k | 50 | 48 |
| 100 RxJS subscribers, 1k writes to another leaf | 1.9 | 2.7 |
| select over 2 paths, 5k writes | 22 | 20 |

Benchmarks vary by about ±15% between runs; differences inside that band are noise.

### Randomized stale-read check (seeds 1-200, about 77,500 checks per mode)

Every consumer (computed, effect, select, BehaviorSubject, `$liveQuery`) is compared with a plain
read after every write. "Artefacts" are differences in how the checker models a value, not missed
updates (for example `"undefined"` as a string, or `[]` from `$liveQuery` on a non-array).

| | Flagged | Real stale reads |
| --- | ---: | ---: |
| current, `exact` | 390 | 197 (95 of them RxJS subscriptions) |
| current, `container` | 347 | 153 |
| v2 (no dependency modes) | 239 | 13 |

## Behaviour differences from the current store

1. **New references on change, also in raw reads.** Signal reads already return new objects in the
   current store (it shallow-clones computed outputs, `cloneComputedOutputs`); v2 gets the same
   from immutability instead of copying on every read. The difference is in raw reads: after
   `store.user.name = 'X'`, `readStore('user')` / `returnStore().user` is a new object in v2 and the
   same, edited object in the current store. `cloneComputedOutputs` is a no-op in v2.
2. **The store never edits objects you passed in.** `store.user = obj; store.user.name = 'X'`
   leaves `obj` untouched (the current store mutates it).
3. **A removed path keeps its BehaviorSubject.** Subscribers see `undefined`, then the next value
   (the current store completes the subject).
4. **Only objects and arrays are traversed.** When `nums` holds the string `"x"`, `nums.0` is
   `undefined` (the current store returns the character `"x"`).
5. **No wake modes.** `setDependencyMode`, `setTrackReads`, `setCloneComputedOutputs`, the
   `versionBump` options and the proxy cache limit are accepted and ignored. `wakeup(path)`
   re-emits objects and arrays (a shallow copy); for a primitive it has no effect.
6. **`returnStore()` is a snapshot.** Editing it directly is not tracked (it was not tracked before
   either, but now it can also be shared with other snapshots).
7. **Devtools** receive `SET_VALUE_OBSERVE`, `ARRAY_OPERATION` and `COMPUTED_STORE_UPDATE`;
   the version, behavior-subscription and proxy-metrics events are not emitted.
8. **Internals are gone:** `createServiceGetter` / `getCreateService` return `undefined`.

## What is not done in the prototype

- Public TypeScript types (port the current ones).
- ng-packagr build and the package entry-point test.
- Unobserved-subject cleanup (the current store completes a subject 50 ms after its last
  subscriber leaves; v2 keeps it until the path is cleaned up or the store is destroyed).
- Documentation, migration notes and a 1.0 version bump.
