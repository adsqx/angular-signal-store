/**
 * 04 - Named stores, waitForStore, and RxJS interop.
 *
 * Run: bun examples/04-named-stores-and-wait.ts
 *
 * When a service owns `this.store`, use that reference directly. `waitForStore` is for a
 * consumer that may run before the code that creates the named store.
 */
import { SignalStore, type StoreProxy } from '@adsq/angular-signal-store';
import { check, section } from './_check';

type Dashboard = { tiles: number; title: string };

const signalStore = new SignalStore(null);

section('waitForStore resolves when the store is created');
const pending = signalStore.waitForStore<Dashboard>('dashboard', { timeoutMs: 1_000 });
queueMicrotask(() => {
  signalStore.createStore<Dashboard>({ tiles: 12, title: 'Ops' }, 'dashboard');
});
const dashboard = await pending;
check('the awaited proxy reads the store', dashboard.tiles(), 12);
check('an existing store resolves immediately', (await signalStore.waitForStore('dashboard')) === dashboard, true);

section('registry lookups');
check('useStore returns the same proxy', signalStore.useStore('dashboard') === (dashboard as unknown), true);
const typed = signalStore.useStore('dashboard') as unknown as StoreProxy<Dashboard>; // useStore is not generic
check('cast to a typed proxy', typed.title(), 'Ops');
check('getStore returns the instance', typeof signalStore.getStore('dashboard')?.batch, 'function');
check('getStore is undefined for unknown names', signalStore.getStore('nope'), undefined);
check('useStore throws for unknown names', throws(() => signalStore.useStore('nope')), true);
check('names are unique', throws(() => signalStore.createStore<Dashboard>({ tiles: 0, title: '' }, 'dashboard')), true);

section('timeout and abort');
const timedOut = await signalStore.waitForStore('never', { timeoutMs: 10 }).catch((e: Error) => e.message);
check('timeout message', timedOut, "waitForStore('never') timed out after 10ms.");
const abort = new AbortController();
const aborted = signalStore.waitForStore('also-never', { signal: abort.signal }).catch((e: Error) => e.name);
abort.abort();
check('abort rejects with an AbortError', await aborted, 'AbortError');

section('RxJS interop');
const seen: string[] = [];
const subscription = typed.getObservable('title').subscribe((title) => seen.push(title));
const label: string[] = [];
const labelSub = typed.select(() => `${typed.title()} (${typed.tiles()})`).subscribe((v) => label.push(v));
const draft = typed.$draft; // typed, plain-JSON write view
draft.title = 'Ops v2';
draft.tiles = 13;
check('getObservable emits the current value first, then changes', seen, ['Ops', 'Ops v2']);
check('select re-emits when any path it read changes', label, ['Ops (12)', 'Ops v2 (12)', 'Ops v2 (13)']);
check('getComputed is a signal', typed.getComputed('tiles')(), 13);
subscription.unsubscribe();
labelSub.unsubscribe();

section('destroyStore');
signalStore.destroyStore('dashboard');
check('the name is released', signalStore.getStore('dashboard'), undefined);
check('and can be created again', signalStore.createStore<Dashboard>({ tiles: 1, title: 'new' }, 'dashboard').title(), 'new');

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

console.log('\n04-named-stores-and-wait: all checks passed');
