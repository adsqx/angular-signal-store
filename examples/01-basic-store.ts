/**
 * 01 - Basic store: callable reads, assignment writes, fine-grained wake, batching.
 *
 * Run: bun examples/01-basic-store.ts
 *
 * `@adsq/angular-signal-store` resolves to ../src through examples/tsconfig.json; in your own
 * app the import is identical and resolves to the installed package.
 */
import { computed } from '@angular/core';
import { SignalStore } from '@adsq/angular-signal-store';
import { check, section } from './_check';

type AppState = {
  user: { name: string; tags: string[]; preferences?: Record<string, unknown> };
  dashboard: { tiles: number };
};

// In an Angular app: `inject(SignalStore)`. `new SignalStore(null)` works without DI.
const signalStore = new SignalStore(null);
const store = signalStore.createStore<AppState>({
  user: { name: 'Ann', tags: ['admin'] },
  dashboard: { tiles: 12 },
}, 'app');

// The declared type of a leaf is callable, so assignments go through a plain-state view of
// the same proxy. Reads always go through `store`.
const draft = store as unknown as AppState;

section('reads and writes');
check('read a leaf', store.user.name(), 'Ann');
draft.user.name = 'Ada';
check('assignment writes', store.user.name(), 'Ada');
store.setValue('dashboard.tiles', 13); // also writes, but any path and value compile
check('setValue writes', store.dashboard.tiles(), 13);
check('read a branch', store.user(), { name: 'Ada', tags: ['admin'] });

section('missing paths, undefined and delete');
check('a missing path reads as undefined', store.user.preferences, undefined);
draft.user.preferences = {};
draft.user.preferences.theme = 'dark';
check('dynamic keys work once the parent exists', store.user.preferences?.theme?.(), 'dark');
draft.user.preferences.theme = undefined; // assigning undefined removes the key
check('undefined removes the key', store.user.preferences?.theme, undefined);

section('fine-grained wake');
let nameRuns = 0;
let tilesRuns = 0;
let userRuns = 0;
const name = computed(() => (nameRuns++, store.user.name()));
const tiles = computed(() => (tilesRuns++, store.dashboard.tiles()));
const user = computed(() => (userRuns++, JSON.stringify(store.user())));
const readAll = () => [name(), tiles(), user()];
readAll();
[nameRuns, tilesRuns, userRuns] = [0, 0, 0];

draft.user.name = 'Grace';
readAll();
check('a write re-runs the consumer of that path', nameRuns, 1);
check('...and the consumer of its parent branch', userRuns, 1);
check('...but not unrelated consumers', tilesRuns, 0);

section('batch');
const summary = computed(() => `${store.user.name()} / ${store.dashboard.tiles()}`);
const result = store.batch(() => {
  draft.user.name = 'Linus';
  draft.dashboard.tiles = 16;
  check('readStore sees a batched write immediately', store.readStore('dashboard.tiles'), 16);
  return 'done';
});
check('batch returns the callback result', result, 'done');
check('consumers see the whole batch', summary(), 'Linus / 16');
try {
  store.batch(() => {
    draft.user.name = 'Ken';
    throw new Error('boom');
  });
} catch {
  /* the batch still flushes what was written */
}
check('a throwing batch keeps committed writes', summary(), 'Ken / 16');

section('manual wake after an out-of-band change');
store.returnStore().user.name = 'edited behind the proxy';
check('the proxy does not know yet', name(), 'Ken');
store.wakeUp('user.name', 'grained');
check('wakeUp makes consumers re-read', name(), 'edited behind the proxy');

console.log('\n01-basic-store: all checks passed');
