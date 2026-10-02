/**
 * 02 - Arrays: mutators through the proxy, reactive length, shifted indices, derived data,
 * path-based helpers and the fluent chain.
 *
 * Run: bun examples/02-arrays.ts
 */
import { computed, type Signal } from '@angular/core';
import { SignalStore, type CreateStore } from '@adsq/angular-signal-store';
import { check, section } from './_check';

type Service = { name: string; rps: number };
type AppState = { services: Service[]; history: number[] };

const signalStore = new SignalStore(null);
const store = signalStore.createStore<AppState>({
  services: [
    { name: 'api', rps: 120 },
    { name: 'db', rps: 40 },
    { name: 'cache', rps: 300 },
  ],
  history: [],
}, 'arrays');
const draft = store.$draft; // typed, plain-JSON write view

section('mutators return what the native method returns');
check('push returns the new length', draft.history.push(1, 2, 3), 3);
check('pop returns the removed element', draft.history.pop(), 3);
check('unshift returns the new length', draft.history.unshift(0), 3);
check('shift returns the removed element', draft.history.shift(), 0);
check('splice returns the removed elements', draft.history.splice(0, 1), [1]);
check('the array after those calls', store.history(), [2]);

section('reactive length and shifted indices');
let lengthRuns = 0;
let secondRuns = 0;
const count = computed(() => (lengthRuns++, store.services.length));
const second = computed(() => (secondRuns++, store.services[1].name()));
check('length starts at 3', count(), 3);
check('the second item is db', second(), 'db');
[lengthRuns, secondRuns] = [0, 0];
draft.services.splice(0, 1); // removes 'api', shifting every index down
check('length consumer re-runs', [count(), lengthRuns], [2, 1]);
check('shifted-index consumer re-runs', [second(), secondRuns], ['cache', 1]);

section('derive with computed(), which is typed and reactive');
const busy = computed(() => store.services().filter((s) => s.rps > 100));
check('derived value', busy().map((s) => s.name), ['cache']);
draft.services[0].rps = 500; // write one item leaf: db -> 500
check('re-derives when an element changes', busy().map((s) => s.name), ['db', 'cache']);

section('the proxy query methods return signals at runtime');
const filtered: Signal<Service[]> = store.services.filter((s) => s.rps > 400);
check('call the result to read it', filtered().map((s) => s.name), ['db']);

section('typed path helpers (read once, non-reactive)');
const found = store.findInArray('services', (s) => s.name === 'db');
check('findInArray', found, { name: 'db', rps: 500 });
store.updateArrayItemByFind('services', (s) => s.name === 'db', { name: 'db', rps: 50 });
store.updateArrayItem('services', 1, { name: 'cache', rps: 310 });
check('after updates', store.services(), [{ name: 'db', rps: 50 }, { name: 'cache', rps: 310 }]);
store.deleteFromArray('services', (s) => s.rps > 300);
check('deleteFromArray', store.lengthOfArray('services'), 1);

section('fluent chain on the store instance');
const instance = signalStore.getStore('arrays') as unknown as CreateStore<AppState>;
instance.array('services').push({ name: 'edge', rps: 5 }).push({ name: 'auth', rps: 60 }).sort((a, b) => a.rps - b.rps);
check('chained push and sort', store.services().map((s) => s.name), ['edge', 'db', 'auth']);

section('paths: dot and bracket syntax are equivalent');
store.setValue('history.0', 20);
store.setValue('history[0]', 21);
check('path writes reach the element', store.readStore('history[0]'), 21);

console.log('\n02-arrays: all checks passed');
