/**
 * Regression tests for fixed correctness bugs. Each section names the bug it pins.
 * Run: bun test/regressions.test.ts
 */
import { SignalStore } from '../src/index';
import { computed, effect, untracked } from '@angular/core';

const failures: string[] = [];
let checks = 0;
function assert(condition: unknown, message: string): void {
  checks++;
  if (!condition) failures.push(message);
}
const J = (v: unknown) => JSON.stringify(v);
const ss = new SignalStore(undefined as any);
let uid = 0;
const fresh = <T extends object>(data: T): any => ss.createStore(data as any, `reg-${uid++}`);
const raw = (s: any, storeName: string) => ss.getStore(storeName).returnStore();

/* ---------------------------------------------------------------------------------------------
 * Bug 1: a write to an array index is lost after the array is reordered.
 * A cached cursor / proxy kept pointing at the element that used to sit at `a.<i>`.
 * ------------------------------------------------------------------------------------------- */
{
  type Op = { name: string; run: (s: any, inst: any, path: string, arr: () => any) => void; mirror: (a: any[]) => void };
  const el = (v: string) => ({ v });
  const OPS: Op[] = [
    { name: 'splice(0,1)', run: (s, i, p, a) => a().splice(0, 1), mirror: (m) => { m.splice(0, 1); } },
    { name: 'splice(1,1)', run: (s, i, p, a) => a().splice(1, 1), mirror: (m) => { m.splice(1, 1); } },
    { name: 'splice(0,0,new)', run: (s, i, p, a) => a().splice(0, 0, el('n')), mirror: (m) => { m.splice(0, 0, el('n')); } },
    { name: 'splice(1,1,new1,new2)', run: (s, i, p, a) => a().splice(1, 1, el('n1'), el('n2')), mirror: (m) => { m.splice(1, 1, el('n1'), el('n2')); } },
    { name: 'splice(-1,1)', run: (s, i, p, a) => a().splice(-1, 1), mirror: (m) => { m.splice(-1, 1); } },
    { name: 'shift', run: (s, i, p, a) => a().shift(), mirror: (m) => { m.shift(); } },
    { name: 'unshift', run: (s, i, p, a) => a().unshift(el('u')), mirror: (m) => { m.unshift(el('u')); } },
    { name: 'pop', run: (s, i, p, a) => a().pop(), mirror: (m) => { m.pop(); } },
    { name: 'push', run: (s, i, p, a) => a().push(el('p')), mirror: (m) => { m.push(el('p')); } },
    { name: 'reverse', run: (s, i, p, a) => a().reverse(), mirror: (m) => { m.reverse(); } },
    { name: 'sort', run: (s, i, p, a) => a().sort((x: any, y: any) => String(y.v).localeCompare(String(x.v))), mirror: (m) => { m.sort((x, y) => String(y.v).localeCompare(String(x.v))); } },
    { name: 'deleteByIndex(0)', run: (s, i, p) => i.deleteByIndex(p, 0), mirror: (m) => { m.splice(0, 1); } },
    { name: 'deleteByIndex(1)', run: (s, i, p) => i.deleteByIndex(p, 1), mirror: (m) => { m.splice(1, 1); } },
    { name: 'deleteFromArray(v==x)', run: (s, i, p) => i.deleteFromArray(p, (e: any) => e.v === 'x' || e.v === 1), mirror: (m) => { for (let k = m.length - 1; k >= 0; k--) if (m[k].v === 'x' || m[k].v === 1) m.splice(k, 1); } },
    { name: 'deleteFromArray(v==y)', run: (s, i, p) => i.deleteFromArray(p, (e: any) => e.v === 'y'), mirror: (m) => { for (let k = m.length - 1; k >= 0; k--) if (m[k].v === 'y') m.splice(k, 1); } },
    { name: 'delete a[0]', run: (s, i, p, a) => { delete a()[0]; }, mirror: (m) => { m.splice(0, 1); } },
    { name: 'setValueObserve(a.1, undefined)', run: (s, i, p) => i.setValueObserve(`${p}.1`, undefined), mirror: (m) => { m.splice(1, 1); } },
    { name: 'setArrayMethod(splice)', run: (s, i, p) => i.setArrayMethod(p, { start: 0, deleteCount: 1, items: [] }, 'splice'), mirror: (m) => { m.splice(0, 1); } },
    { name: 'setArrayMethod(shift)', run: (s, i, p) => i.setArrayMethod(p, 'shift'), mirror: (m) => { m.shift(); } },
    { name: 'setArrayMethod(reverse)', run: (s, i, p) => i.setArrayMethod(p, undefined, 'reverse'), mirror: (m) => { m.reverse(); } },
    { name: 'setArrayMethod(unshift)', run: (s, i, p) => i.setArrayMethod(p, el('q'), 'unshift'), mirror: (m) => { m.unshift(el('q')); } },
  ];
  const DEPTHS = [
    { label: 'flat', path: 'a', pick: (s: any) => s.a, init: () => ({ a: [el('x'), el('y'), el('z')] }), arrOf: (st: any) => st.a },
    { label: 'nested', path: 'o.p.a', pick: (s: any) => s.o.p.a, init: () => ({ o: { p: { a: [el('x'), el('y'), el('z')] } } }), arrOf: (st: any) => st.o.p.a },
    { label: 'inArray', path: 'g.1.a', pick: (s: any) => s.g[1].a, init: () => ({ g: [{ a: [] }, { a: [el('x'), el('y'), el('z')] }] }), arrOf: (st: any) => st.g[1].a },
  ];
  for (const depth of DEPTHS) {
    for (const op of OPS) {
      for (const writeVia of ['proxy', 'setValue', 'setValueObserve'] as const) {
        for (const prime of ['write', 'read', 'consumer'] as const) {
         // `last`: the index touched last before the reorder (the write cursor sits on that element).
         for (const last of [0, 1, 2]) {
          const label = `${depth.label}/${op.name}/${writeVia}/${prime}/last=${last}`;
          const name = `reg-${uid++}`;
          const s: any = ss.createStore(depth.init() as any, name);
          const inst: any = ss.getStore(name);
          const mirror: any[] = JSON.parse(J(depth.arrOf(depth.init())));
          const arr = () => depth.pick(s);
          const tracked: Array<{ idx: number; sig: any }> = [];
          // Prime every index so cursor / proxy / version caches for `<path>.<i>` exist.
          for (const k of [0, 1, 2].filter((x) => x !== last).concat(last)) {
            if (prime === 'write') arr()[k].v = k + 10;
            else if (prime === 'read') arr()[k].v();
            else tracked.push({ idx: k, sig: computed(() => arr()[k]?.v?.()) });
          }
          if (prime === 'write') mirror.forEach((m, k) => { m.v = k + 10; });
          for (const t of tracked) t.sig();
          op.run(s, inst, depth.path, arr);
          op.mirror(mirror);
          const removed = new Set<any>();
          // Writes after the reorder must hit the element now sitting at each index.
          for (let n = 0; n < mirror.length; n++) {
            const k = (n + last) % mirror.length;
            const val = `w${k}`;
            mirror[k].v = val;
            if (writeVia === 'proxy') arr()[k].v = val;
            else if (writeVia === 'setValue') s.setValue(`${depth.path}.${k}.v`, val);
            else s.setValueObserve(`${depth.path}.${k}.v`, val);
          }
          const live = depth.arrOf(raw(s, name));
          assert(J(live) === J(mirror), `[bug1 write] ${label}: store ${J(live)} !== expected ${J(mirror)}`);
          for (let k = 0; k < mirror.length; k++) {
            assert(arr()[k].v() === `w${k}`, `[bug1 read] ${label}: proxy read at ${k} is ${J(arr()[k].v())}`);
          }
          for (const t of tracked) {
            const want = t.idx < mirror.length ? `w${t.idx}` : undefined;
            assert(t.sig() === want, `[bug1 wake] ${label}: consumer at ${t.idx} sees ${J(t.sig())}, expected ${J(want)}`);
          }
         }
        }
      }
    }
  }
  // Whole-element and whole-array replacement after the cursor sat inside the old branch.
  {
    const s = fresh({ a: [{ v: 'x' }, { v: 'y' }] });
    s.a[0].v = 1;
    s.a = [{ v: 'n0' }, { v: 'n1' }];
    s.a[0].v = 5;
    assert(J(s.a()) === J([{ v: 5 }, { v: 'n1' }]), `[bug1 replace-array] ${J(s.a())}`);
    s.a[1] = { v: 'r' };
    s.a[1].v = 6;
    assert(J(s.a()) === J([{ v: 5 }, { v: 6 }]), `[bug1 replace-element] ${J(s.a())}`);
  }
}

if (failures.length) {
  console.error(`${failures.length} of ${checks} regression checks FAILED`);
  for (const f of failures.slice(0, 40)) console.error('  - ' + f);
  if (failures.length > 40) console.error(`  ... ${failures.length - 40} more`);
  process.exit(1);
}
console.log(`regressions OK (${checks} checks)`);
