// Compile-time contract: the proxy types match what the proxy returns at runtime.
// Typechecked by `npm run test:types`.
import type { Signal } from '@angular/core';
import type { StoreProxy } from '../src/index';

type Item = { id: number; title: string; done: boolean };
type State = { items: Item[]; tags: string[]; user: { name: string } };
declare const store: StoreProxy<State>;

// Array query methods return a signal of the result.
const done: Signal<Item[]> = store.items.filter((i) => i.done);
const doneNow: Item[] = store.items.filter((i) => i.done)();
const first: Signal<Item | undefined> = store.items.find((i) => i.id === 1);
const titles: Signal<string[]> = store.items.map((i) => i.title);
const total: Signal<number> = store.items.reduce((sum, i) => sum + i.id, 0);
const hasTag: Signal<boolean> = store.tags.includes('a');
const byValue: Signal<string[]> = store.tags.filter('a');
// @ts-expect-error — the query result is a signal, not an array
const wrong: Item[] = store.items.filter((i) => i.done);

// Reads, indexing, length and mutations keep their types.
const all: Item[] = store.items();
const title: string = store.items[0].title();
const len: number = store.items.length;
const pushed: number = store.items.push({ id: 3, title: 't', done: false });
const name: string = store.user.name();

void [done, doneNow, first, titles, total, hasTag, byValue, wrong, all, title, len, pushed, name];

// select / computedOf hand the projection the live proxy; every node has $val / $signal.
declare const api: import('../src/index').CreateStore<State>;
const sel = api.select((s) => s.user.name());
const cmp: Signal<number> = api.computedOf((s) => s.items().length);
const plain: string = store.user.name.$val;
const sig: Signal<string> = store.user.name.$signal;
const itemsVal: Item[] = store.items.$val;
void [sel, cmp, plain, sig, itemsVal];

// State declared as an interface (no index signature) is accepted.
interface Settings { theme: string; size: number }
declare const ss: import('../src/index').SignalStore;
const settings = ss.createStore<Settings>({ theme: 'dark', size: 1 }, 'settings');
const theme: string = settings.theme();
void theme;
