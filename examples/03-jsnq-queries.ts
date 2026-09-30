/**
 * 03 - Optional JSNQ queries: mutate, $query, $queryOne and $liveQuery.
 *
 * Run: bun examples/03-jsnq-queries.ts
 *
 * The query engine lives behind a separate entry point. Until you import
 * '@adsq/angular-signal-store/jsnq' the query methods throw an error that names it.
 */
import { computed } from '@angular/core';
import { SignalStore } from '@adsq/angular-signal-store';
import where from '@adsq/jsnq/operators/where';
import update from '@adsq/jsnq/operators/update';
import { check, section } from './_check';

type User = { id: number; name: string; active: boolean; score: number };

// The bundled declarations do not include the proxy's JSNQ methods; declare what you use.
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
    { id: 1, name: 'Ann', active: true, score: 10 },
    { id: 2, name: 'Bob', active: false, score: 20 },
    { id: 3, name: 'Cy', active: true, score: 30 },
  ],
}, 'users');
const users = store.users as unknown as Queryable<User>;

section('without the entry point');
let message = '';
try {
  users.$query(where('active', '===', true));
} catch (error) {
  message = String(error);
}
check('the error names the missing entry point', message.includes('@adsq/angular-signal-store/jsnq'), true);

// In an app this is a plain side-effect import at bootstrap: import '@adsq/angular-signal-store/jsnq';
await import('@adsq/angular-signal-store/jsnq');

section('snapshots');
check('$query', users.$query(where('active', '===', true)).map((u) => u.name), ['Ann', 'Cy']);
check('$queryOne', users.$queryOne(where('id', '===', 2))?.name, 'Bob');
check('$queryOne with no match is null', users.$queryOne(where('id', '===', 99)), null);
const isolated = users.$query(where('id', '===', 1), update('name', 'changed-in-the-copy'));
check('mutating operators inside $query act on a copy', [isolated[0].name, store.users()[0].name], ['changed-in-the-copy', 'Ann']);

section('live queries are reactive');
const live = users.$liveQuery(where('active', '===', true));
let runs = 0;
const activeCount = computed(() => (runs++, live().length));
check('starts at 2 active users', activeCount(), 2);

section('mutate commits to the store');
const updated = users.mutate(where('active', '===', true), update('score', (score: number) => score + 1));
check('mutate returns the updated array', updated.map((u) => u.score), [11, 20, 31]);
check('the store reflects it', store.users().map((u) => u.score), [11, 20, 31]);
users.mutate(where('id', '===', 2), update('active', true));
check('the live query re-runs', [activeCount(), runs], [3, 2]);

section('plain array writes wake live queries too');
store.users.push({ id: 4, name: 'Di', active: true, score: 40 });
check('after push', activeCount(), 4);

console.log('\n03-jsnq-queries: all checks passed');
