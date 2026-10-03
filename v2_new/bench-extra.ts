/**
 * Scenarios where the immutable core could cost more than in-place writes. Usage:
 *   bun v2_new/bench-extra.ts <src-dir>   (../src for the current store, src for v2)
 */
import { performance } from 'node:perf_hooks';
import { computed, effect } from '@angular/core';
const dir = process.argv[2]!;
const { SignalStore } = await import(dir + '/index.ts');
const ss = new SignalStore(null);
let n = 0;
const make = (data: unknown) => ss.createStore(data, `bx-${n++}`) as any;
const inst = (s: any) => ss.getStore(`bx-${n - 1}`);

function time(name: string, fn: () => unknown, rounds = 5): void {
  fn();
  const t: number[] = [];
  for (let r = 0; r < rounds; r++) { const s = performance.now(); fn(); t.push(performance.now() - s); }
  t.sort((a, b) => a - b);
  console.log(`${name.padEnd(44)}\t${t[Math.floor(rounds / 2)]!.toFixed(2)}`);
}

time('push x10k into 10k array (no batch)', () => {
  const s = make({ list: Array.from({ length: 10_000 }, (_, i) => ({ id: i })) });
  for (let i = 0; i < 10_000; i++) s.list.push({ id: i });
}, 3);
time('push x10k into 10k array (one batch)', () => {
  const s = make({ list: Array.from({ length: 10_000 }, (_, i) => ({ id: i })) });
  inst(s).batch(() => { for (let i = 0; i < 10_000; i++) s.list.push({ id: i }); });
}, 3);
time('worst case: push + tracked read x2k, 10k array', () => {
  const s = make({ list: Array.from({ length: 10_000 }, (_, i) => ({ id: i })) });
  const len = computed(() => s.list().length);
  let x = 0;
  for (let i = 0; i < 2_000; i++) { s.list.push({ id: i }); x += len(); }
  return x;
}, 3);
time('update 1k items by index (no batch)', () => {
  const s = make({ list: Array.from({ length: 1_000 }, (_, i) => ({ id: i, v: 0 })) });
  for (let i = 0; i < 1_000; i++) s.list[i].v = i;
});
time('write 1k keys of a 1k-key object', () => {
  const o: Record<string, number> = {};
  for (let i = 0; i < 1_000; i++) o['k' + i] = i;
  const s = make({ o });
  for (let i = 0; i < 1_000; i++) s.o['k' + i] = -i;
});
time('1k computeds on items, write one item x1k', () => {
  const s = make({ list: Array.from({ length: 1_000 }, (_, i) => ({ id: i, v: 0 })) });
  const cs = Array.from({ length: 1_000 }, (_, i) => computed(() => s.list[i].v()));
  cs.forEach((c) => c());
  let sum = 0;
  for (let k = 0; k < 1_000; k++) { s.list[7].v = k; for (const c of cs) sum += c(); }
  return sum;
}, 3);
time('deep read x200k (cached proxies)', () => {
  const s = make({ a: { b: { c: { d: 1 } } } });
  const d = s.a.b.c;
  let x = 0;
  for (let i = 0; i < 200_000; i++) x += d.d();
  return x;
});
time('100 subscribers, 1k writes to one leaf', () => {
  const s = make({ a: { b: 0 }, other: { x: 0 } });
  const subs = Array.from({ length: 100 }, (_, i) => s.other.x.subscribe(() => {}));
  for (let i = 0; i < 1_000; i++) s.a.b = i;
  subs.forEach((u: any) => u.unsubscribe());
});
time('select over 2 paths, 5k writes', () => {
  const s = make({ a: 0, b: 0, c: 0 });
  let last = 0;
  const sub = inst(s).select((st: any) => st.a() + st.b()).subscribe((v: number) => (last = v));
  for (let i = 0; i < 5_000; i++) { s.a = i; s.c = i; }
  sub.unsubscribe();
  return last;
});
