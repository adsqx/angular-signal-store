# Examples

Short, runnable, headless examples of `@adsq/angular-signal-store`. They run under
[`bun`](https://bun.sh) with no browser and no Angular application: Angular's signal primitives
(`computed`) work outside a component, and `new SignalStore(null)` stands in for dependency
injection. Every example asserts what it claims and exits non-zero on the first failure.

```sh
npm run examples                        # run all of them
bun examples/01-basic-store.ts          # run one
npm run typecheck:examples              # tsc over the examples
```

| File | Shows |
| --- | --- |
| [`01-basic-store.ts`](./01-basic-store.ts) | Callable reads, assignment writes, `setValue`, missing paths and `undefined`, fine-grained wake (counting `computed` re-runs), `batch`, `wakeUp`. |
| [`02-arrays.ts`](./02-arrays.ts) | Mutators and their return values, reactive `length`, shifted-index wake, deriving with `computed`, proxy query methods returning signals, typed path helpers, the fluent `array()` chain, dot and bracket paths. |
| [`03-jsnq-queries.ts`](./03-jsnq-queries.ts) | The optional `/jsnq` entry: the error before it is imported, `$query`, `$queryOne`, `$liveQuery`, `mutate`. |
| [`04-named-stores-and-wait.ts`](./04-named-stores-and-wait.ts) | `waitForStore` (resolve, timeout, abort), `useStore` / `getStore` / `destroyStore`, `getObservable`, `select`, `getComputed`. |
| [`05-devtools.ts`](./05-devtools.ts) | `provideSignalStoreDevtools`, `DevService`, `devActivation`, the `action$` and `readAction$` streams. |

## How imports resolve

The examples import `@adsq/angular-signal-store`, `.../jsnq` and `.../devtools` exactly as an
application does. `examples/tsconfig.json` maps those specifiers to `../src`, which bun and
`tsc` both honour, so the examples run against the working tree without a build. In your own
project the same imports resolve to the installed package.

## Conventions used

- **`store`** is the proxy returned by `createStore`. Reads go through it with a call.
- **`draft`** is `store as unknown as State`: the same runtime object typed as plain state, so
  that assignments compile under `strict`. Use it for writes only.
- `_check.ts` holds the tiny `check(label, actual, expected)` helper.

These files are not part of the published package: the `files` whitelist in `package.json`
ships only `dist`, `README.md`, `LICENSE`, `SKILL.md` and `AGENTS.md`.
