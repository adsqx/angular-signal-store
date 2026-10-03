/**
 * Many LIVE consumers (like template bindings / effects), each reading a different item; writes touch
 * one item. Measures the per-write cost of notifying + re-validating consumers, and how many consumer
 * functions actually re-run. Usage: bun v2_new/bench-live.ts <src-dir> [consumers]
 */
import { performance } from 'node:perf_hooks';
import { createWatch } from '@angular/core/primitives/signals';
const dir = process.argv[2]!;
const N = Number(process.argv[3] ?? 5000);
const { SignalStore } = await import(dir + '/index.ts');
const ss = new SignalStore(null);
const s: any = ss.createStore({ items: Array.from({ length: N }, (_, i) => ({ id: i, v: 0 })), other: { x: 0 } }, 'live');
let runs = 0;
const queue: Array<{ run(): void }> = [];
const watches = Array.from({ length: N }, (_, i) => {
  const w = createWatch(() => { runs++; s.items[i].v(); }, (watch) => queue.push(watch), false);
  w.notify(); // schedule the first run
  return w;
});
const flush = () => { while (queue.length) queue.shift()!.run(); };
flush();
const measure = (label: string, write: (k: number) => void, writes = 1000) => {
  runs = 0;
  const t = performance.now();
  for (let k = 1; k <= writes; k++) { write(k); flush(); }
  const ms = performance.now() - t;
  console.log(`${label.padEnd(40)}\t${ms.toFixed(1)} ms\tconsumer runs: ${runs}`);
};
measure(`write one item x1000 (${N} live consumers)`, (k) => { s.items[7].v = k; });
measure(`write outside items x1000`, (k) => { s.other.x = k; });
measure(`push + pop on items x1000`, (k) => { s.items.push({ id: -k, v: 0 }); s.items.pop(); });
watches.forEach((w) => w.destroy());
