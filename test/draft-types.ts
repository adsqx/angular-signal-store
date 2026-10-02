/**
 * Compile-time contract of `$draft` / `CreateStore#draft` (never executed).
 * Run: npm run test:draft-types
 */
import { SignalStore, type CreateStore, type Draft } from '../src/index';

type State = {
  user: { readonly id: number; name: string; tags: readonly string[]; nick?: string };
  items: { id: number; done: boolean }[];
  readonlyList: ReadonlyArray<{ n: number }>;
  count: number;
};

const ss = new SignalStore(null);
const store = ss.createStore<State>({ user: { id: 1, name: 'a', tags: [] }, items: [], readonlyList: [], count: 0 }, 'types');

// plain writes compile
store.$draft.user.name = 'x';
store.$draft.count = store.$draft.count + 1;
store.$draft.user.nick = 'n';
store.$draft.user.tags.push('t'); // readonly is stripped, deeply
store.$draft.user.id = 2; // readonly is stripped
store.$draft.readonlyList.push({ n: 1 });
delete store.$draft.user.nick;

// wrong types do not
// @ts-expect-error number is not assignable to string
store.$draft.user.name = 1;
// @ts-expect-error string is not assignable to number
store.$draft.count = 'x';
// @ts-expect-error unknown key
store.$draft.nope = 1;
// @ts-expect-error array element type is enforced
store.$draft.items.push({ id: 1 });
// @ts-expect-error push of a wrong element type
store.$draft.user.tags.push(5);

// arrays are typed
store.$draft.items.push({ id: 1, done: false });
const length: number = store.$draft.items.length;
const found: { id: number; done: boolean } | undefined = store.$draft.items.find((x) => x.id === 1);
if (found) found.done = true;
store.$draft.items.splice(0, 1);
store.$draft.items.sort((a, b) => a.id - b.id);

// reads are plain data, not callables
const name: string = store.$draft.user.name;
// @ts-expect-error a draft leaf is not callable
store.$draft.user.name();

// the existing callable surface is unchanged
const reactive: string = store.user.name();
// @ts-expect-error the read-typed proxy still rejects direct leaf writes
store.user.name = 'x';

// CreateStore#draft is the same plain type
declare const instance: CreateStore<State>;
instance.draft.user.name = 'x';
// @ts-expect-error
instance.draft.user.name = 1;
const view: Draft<State> = instance.draft;
const viaStore: Draft<State> = store.$draft;

// Draft<T> strips readonly, recurses and keeps functions
type Fn = { cb: (n: number) => string; list: readonly { a: 1 }[] };
const fn: Draft<Fn> = { cb: (n) => String(n), list: [] };
fn.list.push({ a: 1 });

export { length, name, reactive, view, viaStore };
