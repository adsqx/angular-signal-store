/**
 * Contract of `store.$draft` / `CreateStore#draft`: the typed "native JSON" write view.
 * Run: bun test/draft.test.ts
 */
import { computed, untracked } from '@angular/core';
import { SignalStore, type CreateStore, type Draft } from '../src/index';

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { console.error(`FAIL ${msg}`); failures++; }
};
const eq = (actual: unknown, expected: unknown, msg: string) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, `${msg}${a === e ? '' : ` (got ${a}, expected ${e})`}`);
};

type Item = { id: number; title: string; done: boolean };
type State = {
  user: { name: string; age: number; address: { city: string } };
  items: Item[];
  nums: number[];
  other: { count: number };
  maybe?: { x: number };
};
const fresh = () => ({
  user: { name: 'Ann', age: 30, address: { city: 'Oslo' } },
  items: [
    { id: 1, title: 'a', done: false },
    { id: 2, title: 'b', done: false },
    { id: 3, title: 'c', done: false },
  ],
  nums: [3, 1, 2],
  other: { count: 0 },
});

const ss = new SignalStore(undefined as any);
let n = 0;
const make = () => {
  const store = ss.createStore<State>(fresh() as State, `draft-${n++}`);
  return { store, d: store.$draft };
};

/** Counts how often `read()` re-runs, flushing pending notifications first. */
const counted = <R>(read: () => R) => {
  let runs = 0;
  const c = computed(() => (runs++, read()));
  c();
  return { value: () => c(), runs: () => runs, reset: () => { runs = 0; } };
};

// ---- reads: primitives plain, objects are draft proxies
{
  const { store, d } = make();
  ok(d.user.name === 'Ann', 'primitive read returns the plain value');
  ok(typeof d.user.age === 'number', 'number stays a number');
  ok(typeof d.user === 'object' && d.user.address.city === 'Oslo', 'nested object read descends');
  ok(d.user === d.user, 'the same path gives the same draft proxy');
  ok(d.maybe === undefined, 'missing path reads undefined');
  ok(store.$draft === d, '$draft is stable on the root proxy');
  ok((ss.getStore(`draft-${n - 1}`) as unknown as CreateStore<State>).draft === d, 'CreateStore#draft is the same view');
}

// ---- JSON / spread / keys / isArray / for-of / in / length
{
  const { d } = make();
  eq(JSON.parse(JSON.stringify(d.user)), fresh().user, 'JSON.stringify(draft.user) equals the plain data');
  eq(JSON.parse(JSON.stringify(d)), fresh(), 'JSON.stringify(root draft) equals the plain data');
  eq(Object.keys(d.user), ['name', 'age', 'address'], 'Object.keys');
  eq(Object.entries(d.user.address), [['city', 'Oslo']], 'Object.entries');
  const spread = { ...d.user };
  ok(spread.name === 'Ann' && spread.age === 30, 'object spread copies primitives');
  ok(Array.isArray(d.items) && Array.isArray(d.nums), 'Array.isArray is true for draft arrays');
  ok(!Array.isArray(d.user), 'Array.isArray is false for draft objects');
  ok('name' in d.user && !('zzz' in d.user), 'in operator');
  ok(d.items.length === 3 && d.nums.length === 3, 'length');
  const seen: number[] = [];
  for (const it of d.items) seen.push(it.id);
  eq(seen, [1, 2, 3], 'for...of over a draft array');
  eq([...d.nums], [3, 1, 2], 'array spread');
  eq(JSON.parse(JSON.stringify(d.items)), fresh().items, 'JSON.stringify(draft array)');
  eq(Object.keys(d.nums), ['0', '1', '2'], 'Object.keys of an array');
  eq(d.items.map((x) => x.title), ['a', 'b', 'c'], 'map over the draft view');
  eq(d.nums.slice(1), [1, 2], 'slice');
  eq(d.nums.indexOf(2), 2, 'indexOf');
  ok(d.nums.includes(1) && d.items.some((x) => x.done === false) && d.items.every((x) => x.id > 0), 'includes/some/every');
  eq(d.nums.reduce((a, b) => a + b, 0), 6, 'reduce');
  eq(d.nums.join('-'), '3-1-2', 'join');
  eq(d.items.filter((x) => x.id > 1).map((x) => x.id), [2, 3], 'filter returns draft elements');
}

// ---- assignment writes through, wakes only the written path's consumers
{
  const { store, d } = make();
  const name = counted(() => store.user.name());
  const age = counted(() => store.user.age());
  const count = counted(() => store.other.count());
  const userObj = counted(() => store.user());
  d.user.name = 'Warm'; // the store settles its first write; measure after it
  [name, age, count, userObj].forEach((c) => (c.value(), c.reset()));

  d.user.name = 'Ada';
  eq([name.value(), age.value(), count.value(), userObj.value().name], ['Ada', 30, 0, 'Ada'], 'assignment is visible through the store');
  eq([name.runs(), age.runs(), count.runs(), userObj.runs()], [1, 0, 0, 1], 'only the written path (and its parent) re-runs');
  ok(store.user.name() === 'Ada', 'store reads the draft write');

  d.other.count = 5;
  eq([count.value(), count.runs(), name.runs(), age.runs()], [5, 1, 1, 0], 'a sibling write wakes only its own consumers');

  d.user.address.city = 'Rome';
  eq(store.user.address.city(), 'Rome', 'deep write');
  d.maybe = { x: 1 };
  eq(store.maybe?.x?.(), 1, 'creating a branch through the draft');
  d.maybe.x = 2;
  eq(store.maybe?.x?.(), 2, 'writing inside the new branch');
}

// ---- delete / undefined
{
  const { store, d } = make();
  delete (d.user as Partial<State['user']>).age;
  ok(store.user.age === undefined && !('age' in d.user), 'delete removes the key (like delete store.user.age)');
  d.user.name = undefined as unknown as string;
  ok(!('name' in d.user), 'assigning undefined deletes, like the store');
  const age = counted(() => store.user.address.city());
  age.reset();
  delete (d as Partial<State>).maybe;
  eq(age.runs(), 0, 'unrelated consumers do not re-run on delete');
}

// ---- draft reads do NOT subscribe
{
  const { store, d } = make();
  const viaDraft = counted(() => `${d.user.name}:${d.items[0].title}:${d.items.length}`);
  const viaUntracked = counted(() => untracked(() => store.user.name()));
  viaDraft.reset(); viaUntracked.reset();
  d.user.name = 'Zed';
  d.items[0].title = 'zz';
  d.items.push({ id: 9, title: 'n', done: false });
  viaDraft.value(); viaUntracked.value();
  eq(viaDraft.runs(), 0, 'a computed that only reads through the draft is never woken');
  const mixed = counted(() => `${store.user.age()}|${d.user.name}`);
  d.user.age = 30;
  mixed.value(); mixed.reset();
  d.user.age = 31;
  ok(mixed.value() === '31|Zed' && mixed.runs() === 1, 'a reactive read next to a draft read subscribes only to the reactive one');
  mixed.reset();
  d.user.name = 'Yan';
  eq(mixed.runs(), 0, 'the draft read inside it did not subscribe');
}

// ---- arrays: mutators route to the store's array methods (precise wake)
{
  const { store, d } = make();
  const len = counted(() => store.items.length);
  const first = counted(() => store.items[0].title());
  const unrelated = counted(() => store.other.count());
  const numsLen = counted(() => store.nums.length);
  [len, first, unrelated, numsLen].forEach((c) => c.reset());

  ok(d.items.push({ id: 4, title: 'd', done: false }) === 4, 'push returns the new length');
  eq([len.value(), len.runs(), unrelated.runs(), numsLen.runs(), first.runs()], [4, 1, 0, 0, 0], 'push wakes the array consumers only');
  eq(store.items().map((x: Item) => x.id), [1, 2, 3, 4], 'push result in the store');

  eq(d.items.pop()?.id, 4, 'pop returns the removed element');
  eq(d.items.shift()?.id, 1, 'shift returns the removed element');
  ok(d.items.unshift({ id: 0, title: 'z', done: false }) === 3, 'unshift returns the new length');
  eq(d.items.splice(1, 1).map((x) => x.id), [2], 'splice returns the removed elements');
  eq(store.items().map((x: Item) => x.id), [0, 3], 'array after mutators');
  eq([first.value(), first.runs() > 0], ['z', true], 'index consumer sees the shifted element');

  numsLen.reset();
  const sorted = d.nums.sort((a, b) => a - b);
  eq(store.nums(), [1, 2, 3], 'sort writes through the store');
  ok(sorted === d.nums, 'sort returns the draft array');
  d.nums.reverse();
  eq(store.nums(), [3, 2, 1], 'reverse writes through the store');
  eq(numsLen.runs(), 0, 'sort/reverse do not wake a length-only consumer');
  d.nums.fill(7);
  eq(store.nums(), [7, 7, 7], 'fill assigns the array');
  d.nums.length = 1;
  eq(store.nums(), [7], 'shrinking length truncates through the store');
  d.nums[0] = 9;
  eq(store.nums(), [9], 'index assignment');
}

// ---- find-then-write: elements handed out are draft proxies
{
  const { store, d } = make();
  const row2 = counted(() => store.items[1].done());
  const row1 = counted(() => store.items[0].done());
  const total = counted(() => store.other.count());
  d.items[1].done = false; d.items[0].done = false;
  [row2, row1, total].forEach((c) => (c.value(), c.reset()));
  d.items.find((x) => x.id === 2)!.done = true;
  eq([store.items[1].done(), row2.value()], [true, true], 'find(...)!.done = true writes through');
  eq([row2.runs(), row1.runs(), total.runs()], [1, 0, 0], 'precise wake for find-then-write');
  for (const it of d.items) if (it.id === 3) it.title = 'C';
  eq(store.items[2].title(), 'C', 'for-of element write');
  d.items.filter((x) => x.id < 3).forEach((x) => (x.title = x.title.toUpperCase()));
  eq(store.items().map((x: Item) => x.title), ['A', 'B', 'C'], 'forEach over filtered draft elements');
  d.items[0].title = 'first';
  eq(store.items[0].title(), 'first', 'index then property write');
}

// ---- unwrap of draft proxies
{
  const { store, d } = make();
  d.other = d.user as never;
  const stored = store.readStore('other') as { name: string };
  ok(stored.name === 'Ann' && !types(stored), 'assigning a draft proxy stores the plain value');
  d.items.push(d.items[0]);
  const last = (store.readStore('items') as Item[])[3];
  ok(last.id === 1 && !types(last), 'a draft proxy passed to push is unwrapped');
  d.nums = d.nums as never;
  ok(Array.isArray(store.readStore('nums')), 'self assignment keeps a real array');
  function types(v: object) { return v.constructor !== Object; }
}

// ---- always the CURRENT value
{
  const { store, d } = make();
  const user = d.user;
  const addr = d.user.address;
  ok(user.name === 'Ann', 'precondition');
  store.user = { name: 'Bob', age: 1, address: { city: 'Rio' } } as never;
  ok(user.name === 'Bob' && addr.city === 'Rio', 'held draft proxies reflect a replaced parent');
  user.age = 2;
  eq(store.user.age(), 2, 'writing through a held proxy after the parent was replaced');

  const items = d.items;
  const second = d.items[1];
  const head = d.items[0];
  ok(second.id === 2 && head.id === 1, 'precondition');
  head.title = 'written-before';
  d.items.reverse();
  ok(head.id === 3, 'a proxy bound to index 0 reads the element now at index 0');
  store.cleanupPath('items'); // documented store caveat after reordering; the draft inherits the store's write path
  head.title = 'written-after';
  eq(store.items().map((x: Item) => x.title), ['written-after', 'b', 'written-before'], 'writes after a reorder land on the current element');
  eq(d.items.map((x) => x.id), [3, 2, 1], 'reorder is visible through the draft');
  ok(items.length === 3 && second.id === 2, 'a proxy bound to a path reads what is at that path now');
  store.items = [{ id: 9, title: 'n', done: false }] as never;
  ok(items.length === 1 && items[0].id === 9, 'held array proxy reflects a replaced array');
  ok(second.id === undefined, 'a path that no longer exists reads undefined');
}

// ---- standalone instance (no proxy binding) behaves the same
{
  const direct = ss.createStore<State>(fresh() as State, `draft-direct`);
  const inst = ss.getStore('draft-direct') as unknown as CreateStore<State>;
  inst.draft.user.name = 'Via instance';
  eq(direct.user.name(), 'Via instance', 'CreateStore#draft writes the store');
  inst.draft.items.push({ id: 7, title: 'q', done: true });
  eq(direct.items.length, 4, 'CreateStore#draft array push');
}

// ---- type surface at runtime
{
  const { d } = make();
  const typed: Draft<State> = d;
  ok(typed.user.name === 'Ann', 'Draft<State> is the plain data type');
}

if (failures > 0) { console.error(`\n${failures} assertion(s) failed`); process.exit(1); }
console.log('\nAll draft contract tests passed.');
