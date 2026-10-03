// Randomized under-wake checker.
// Usage: bun check.ts <repo-root> <seedFrom> <seedTo> <exact|container> <dev:0|1> [outfile]
// Every consumer is a memoized reader (Angular computed / rxjs subscription) over a store path.
// After every write, each consumer's current value must equal the same read done as a plain
// read of the raw store data. A stale value == a wake that never happened (under-wake).
// The op/consumer sequence depends only on the seed (never on store state), so two trees can be compared 1:1.
const [root, sFrom, sTo, mode, dev, outFile] = process.argv.slice(2) as string[];
(globalThis as any).WeakRef = class { constructor(private v: unknown) {} deref() { return this.v; } };
(globalThis as any).FinalizationRegistry = class { register() {} unregister() {} };
const { SignalStore } = await import(root + '/src/index');
const { computed } = await import(root + '/node_modules/@angular/core');
await import(root + '/src/jsnq');
const { where, update } = await import(root + '/node_modules/@adsq/jsnq');
console.warn = () => {};
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const fakeDev = {
  action$: { subscribe() { return { unsubscribe() {} }; } },
  readAction$: { subscribe() { return { unsubscribe() {} }; } },
  emitAction() {}, emitRead() {},
  getBehaviorKeys(s: any) { return Object.keys(s).sort(); },
  getComputedKeys(s: any) { return Object.keys(s).sort(); },
};

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const base = () => ({
  key: 'a', n: 1, flag: true, nul: null as any,
  user: { name: 'Ann', age: 30, profile: { name: 'P', tags: ['a', 'b'] } },
  items: [{ id: 1, title: 'one', done: false }, { id: 2, title: 'two', done: true }, { id: 3, title: 'three', done: false }],
  nums: [3, 1, 2], matrix: [[1, 2], [3, 4]], empty: {} as any,
  obj: { map: { x: 1 }, sort: [3, 1, 2] },
});

type Seg = string | number;
const P = (s: string): Seg[] => s.split('.').map((x) => (/^\d+$/.test(x) ? Number(x) : x));
const PATHS: Seg[][] = [
  'key', 'n', 'flag', 'nul', 'user', 'user.name', 'user.age', 'user.profile', 'user.profile.name', 'user.profile.tags', 'user.profile.tags.1', 'user.profile.tags.0',
  'items', 'items.0', 'items.1', 'items.0.title', 'items.1.done', 'items.2.title', 'items.5', 'items.1.meta', 'nums', 'nums.0', 'nums.2', 'nums.3', 'matrix', 'matrix.0', 'matrix.1.0',
  'empty', 'empty.a', 'empty.a.b', 'obj', 'obj.map', 'obj.map.x', 'obj.map.y', 'obj.sort', 'obj.sort.0',
  'zzz', 'zzz.q', 'user.extra', 'user.extra.deep', 'user.profile.bio',
].map(P);
const WELLP = () => Object.keys(WPATHS).map(P);
const ARRAYS: Seg[][] = ['items', 'nums', 'user.profile.tags', 'obj.sort', 'matrix', 'matrix.0'].map(P);

// ---- reads: proxy side and plain side --------------------------------------
const isFn = (x: unknown) => typeof x === 'function';
function walkProxy(s: any, path: Seg[]): any { let n = s; for (const k of path) { if (n == null || (typeof n !== 'function' && typeof n !== 'object')) return undefined; n = n[k]; } return n; }
function walkPlain(st: any, path: Seg[]): any { let n = st; for (const k of path) { if (n == null || typeof n !== 'object') return undefined; n = n[k]; } return n; }
const J = (v: unknown) => { try { return JSON.stringify(v) ?? 'undefined'; } catch { return 'ERRJ'; } };
const pred = (x: any) => (typeof x === 'object' && x ? !!x.done : typeof x === 'number' ? x > 1 : false);

type Spec = { kind: string; path: Seg[]; arg?: number };
function proxyRead(s: any, ss: any, name: string, sp: Spec, c?: any): any {
  const n = walkProxy(s, sp.path);
  if (c && (n === undefined || plainRead(ss.getStore(name).returnStore(), sp) === undefined)) c.miss = true; // read touched a missing path/value: nothing trackable
  switch (sp.kind) {
    case 'call': return isFn(n) ? n() : n;
    case 'sig': return n === undefined ? undefined : n?.$signal?.();
    case 'str': return n === undefined ? undefined : (typeof n === 'object' && n !== null ? JSON.stringify(n) : String(n));
    case 'len': return n === undefined ? undefined : n.length;
    case 'json': return n === undefined ? undefined : JSON.stringify(isFn(n) ? n() : n);
    case 'getComputed': return s.getComputed(sp.path.join('.'))();
    case 'filter': return n?.filter ? n.filter(pred)() : undefined;
    case 'some': return n?.some ? n.some(pred)() : undefined;
    case 'find': return n?.find ? n.find(pred)() : undefined;
    case 'indexOf': return n?.indexOf ? n.indexOf(sp.arg ?? 1)() : undefined;
    case 'includes': return n?.includes ? n.includes(sp.arg ?? 1)() : undefined;
    case 'liveQuery': return n?.$liveQuery ? n.$liveQuery(where('done', '===', true))() : undefined;
    case 'nested2': { // two-level read: parent branch value, child read from it
      const par = walkProxy(s, sp.path.slice(0, -1)); const v = isFn(par) ? par() : undefined; return v && typeof v === 'object' ? v[sp.path[sp.path.length - 1]] : undefined; }
  }
  throw new Error('kind ' + sp.kind);
}
function plainRead(st: any, sp: Spec): any {
  const n = walkPlain(st, sp.path);
  switch (sp.kind) {
    case 'call': case 'sig': case 'getComputed': return n;
    case 'str': return n === undefined ? undefined : (typeof n === 'object' && n !== null ? JSON.stringify(n) : String(n));
    case 'len': return n === undefined ? undefined : Array.isArray(n) || typeof n === 'string' ? n.length : (n as any)?.length;
    case 'json': return n === undefined ? undefined : JSON.stringify(n);
    case 'filter': return Array.isArray(n) ? n.filter(pred) : undefined;
    case 'some': return Array.isArray(n) ? n.some(pred) : undefined;
    case 'find': return Array.isArray(n) ? n.find(pred) : undefined;
    case 'indexOf': return Array.isArray(n) ? n.indexOf(sp.arg ?? 1) : undefined;
    case 'includes': return Array.isArray(n) ? n.includes(sp.arg ?? 1) : undefined;
    case 'liveQuery': return Array.isArray(n) ? n.filter((x: any) => x && x.done === true) : undefined;
    case 'nested2': { const par = walkPlain(st, sp.path.slice(0, -1)); return par && typeof par === 'object' ? par[sp.path[sp.path.length - 1]] : undefined; }
  }
}
const KINDS_ANY = ['call', 'call', 'call', 'sig', 'str', 'json', 'getComputed', 'nested2'];
const KINDS_ARR = ['len', 'filter', 'some', 'find', 'indexOf', 'includes', 'liveQuery', 'call'];
const SYNC_SHAPES = ['computed', 'computed', 'computed', 'computedOf', 'effectlike'];

// ---- consumers ----------------------------------------------------------------
interface Consumer { id: number; desc: string; obs: boolean; runs: number; get: () => string; truth: (st: any) => string; dispose?: () => void; deferred: boolean; }
let CID = 0;
let BATCHES = 0;

function makeConsumer(s: any, ss: any, name: string, R: () => number, active: boolean): Consumer {
  const pick = <X>(a: X[]) => a[Math.floor(R() * a.length)];
  const roll = R();
  const id = CID++;
  const c: any = { id, runs: 0, obs: false, deferred: false, born: BATCHES, get: () => 'x', truth: () => 'x' };
  const errName = (e: unknown) => 'ERR:' + (e as Error).name;
  if (roll < 0.62) { // signal consumers
    const arrayish = R() < 0.3;
    const path = pick(arrayish ? ARRAYS : (WELL ? WELLP() : PATHS));
    let kind = pick(arrayish ? KINDS_ARR : KINDS_ANY); if (kind === 'nested2' && path.length < 2) kind = 'call';
    const arg = Math.floor(R() * 4);
    const sp: Spec = { kind, path, arg };
    const shape = pick(SYNC_SHAPES);
    const sp2: Spec | null = shape === 'effectlike' ? { kind: 'call', path: pick(WELL ? WELLP() : PATHS) } : null;
    c.desc = `${shape}:${kind}:${path.join('.')}` + (sp2 ? `+${sp2.path.join('.')}` : '');
    if (active) {
      const fn = () => { c.runs++; c.miss = false; try { return J(proxyRead(s, ss, name, sp, c)) + (sp2 ? '|' + J(proxyRead(s, ss, name, sp2, c)) : ''); } catch (e) { return errName(e); } };
      const sigc = shape === 'computedOf' ? s.computedOf(fn) : computed(fn);
      c.get = () => sigc();
      c.truth = (st: any) => J(plainRead(st, sp)) + (sp2 ? '|' + J(plainRead(st, sp2)) : '');
    }
  } else if (roll < 0.74) { // select()
    const path = pick(WELL ? WELLP() : PATHS); const kind = pick(['call', 'json', 'str']);
    const sp: Spec = { kind, path };
    c.desc = `select:${kind}:${path.join('.')}`; c.obs = true; c.deferred = true;
    if (active) {
      let last = 'UNSET';
      const sub = s.select(() => { c.runs++; c.miss = false; try { return J(proxyRead(s, ss, name, sp, c)); } catch (e) { return errName(e); } }).subscribe((v: string) => { last = v; });
      c.get = () => last; c.truth = (st: any) => J(plainRead(st, sp)); c.dispose = () => sub.unsubscribe();
    }
  } else if (roll < 0.84) { // getObservable / getBehaviorSubject
    const path = pick((WELL ? WELLP() : PATHS).filter((p) => p.length <= 3));
    const viaBS = R() < 0.4;
    c.desc = `${viaBS ? 'getBehaviorSubject' : 'getObservable'}:${path.join('.')}`; c.obs = true; c.deferred = true;
    if (active) {
      let last = 'UNSET'; let sub: any; let ok = true;
      try { const o = viaBS ? s.getBehaviorSubject(path.join('.')) : s.getObservable(path.join('.')); sub = o.subscribe((v: unknown) => { last = J(v); }); } catch { ok = false; }
      if (ok) { c.get = () => last; c.truth = (st: any) => J(walkPlain(st, path)); c.dispose = () => sub?.unsubscribe?.(); }
    }
  } else { // proxy .subscribe / .pipe()
    const path = pick((WELL ? WELLP() : PATHS).filter((p) => p.length >= 1 && p.length <= 4));
    const usePipe = R() < 0.4;
    c.desc = `${usePipe ? 'pipe' : 'subscribe'}:${path.join('.')}`; c.obs = true; c.deferred = true;
    if (active) {
      let last = 'UNSET'; let sub: any; let ok = false;
      const n = walkProxy(s, path);
      try { if (n && isFn(n.subscribe)) { const o = usePipe ? n.pipe() : n; sub = o.subscribe((v: unknown) => { last = J(v); }); ok = true; } } catch { ok = false; }
      if (ok) { c.get = () => last; c.truth = (st: any) => J(walkPlain(st, path)); c.dispose = () => sub?.unsubscribe?.(); }
    }
  }
  return c as Consumer;
}

// ---- WELL tier: type-preserving workload over paths that exist initially -------------------------------
const WELL = process.env.WELL === '1';
const WPATHS: Record<string, string> = { key: 'str', n: 'num', flag: 'bool', nul: 'nullnum', user: 'user', 'user.name': 'str', 'user.age': 'num', 'user.profile': 'profile', 'user.profile.name': 'str',
  'user.profile.tags': 'strs', 'user.profile.tags.1': 'str', 'user.profile.tags.0': 'str', items: 'items', 'items.0': 'item', 'items.1': 'item', 'items.0.title': 'str', 'items.1.done': 'bool', 'items.2.title': 'str',
  nums: 'nums', 'nums.0': 'num', 'nums.2': 'num', matrix: 'matrix', 'matrix.0': 'nums', 'matrix.1.0': 'num', empty: 'empty', obj: 'obj', 'obj.map': 'map', 'obj.map.x': 'num', 'obj.sort': 'nums', 'obj.sort.0': 'num' };
const WKEYS = Object.keys(WPATHS);
const WARR = ['items', 'nums', 'user.profile.tags', 'obj.sort', 'matrix', 'matrix.0'];
const WARR_KIND: Record<string, string> = { items: 'item', nums: 'num', 'user.profile.tags': 'str', 'obj.sort': 'num', matrix: 'nums', 'matrix.0': 'num' };
function typed(kind: string, R: () => number): any {
  const r = Math.floor(R() * 6); const pick = <X>(a: X[]) => a[Math.floor(R() * a.length)];
  switch (kind) {
    case 'str': return pick(['x', 'y', '', 'zz', 'Ann', 'q' + r]);
    case 'num': return pick([0, 1, 2, 7, -1, 42]);
    case 'bool': return R() < 0.5;
    case 'nullnum': return R() < 0.5 ? null : r;
    case 'user': return { name: 'U' + r, age: r, profile: { name: 'p' + r, tags: ['t' + r, 'u'] } };
    case 'profile': return { name: 'p' + r, tags: r % 2 ? ['a'] : ['a', 'b', 'c'] };
    case 'item': return { id: r, title: 't' + r, done: R() < 0.5 };
    case 'items': return Array.from({ length: r % 4 }, (_, i) => ({ id: i + r, title: 'T' + i, done: (i + r) % 2 === 0 }));
    case 'nums': return Array.from({ length: r % 4 }, (_, i) => i * r);
    case 'strs': return Array.from({ length: r % 4 }, (_, i) => 's' + i + r);
    case 'matrix': return [[r, 2], [3, r]];
    case 'empty': return r % 2 ? {} : { a: r };
    case 'obj': return { map: { x: r }, sort: [r, 1] };
    case 'map': return { x: r };
  }
}
function doWellOp(s: any, ss: any, name: string, R: () => number, log: string[]): void {
  const pick = <X>(a: X[]) => a[Math.floor(R() * a.length)];
  const inst = ss.getStore(name);
  const one = (): void => {
    const r = R(); const dotted = pick(WKEYS); const path = P(dotted); const val = typed(WPATHS[dotted], R);
    if (r < 0.34) { log.push(`assign ${dotted}=${J(val)}`); const parent = walkProxy(s, path.slice(0, -1)); if (path.length === 1) s[path[0]] = val; else if (parent != null) parent[path[path.length - 1]] = val; }
    else if (r < 0.42) { log.push(`delete ${dotted}`); const parent = walkProxy(s, path.slice(0, -1)); if (path.length === 1) delete s[path[0]]; else if (parent != null) delete parent[path[path.length - 1]]; }
    else if (r < 0.56) { log.push(`setValue ${dotted}=${J(val)}`); s.setValue(dotted, val); }
    else if (r < 0.62) { log.push(`setValueObserve ${dotted}=${J(val)}`); s.setValueObserve(dotted, val); }
    else if (r < 0.86) {
      const ap = pick(WARR); const a = walkProxy(s, P(ap)); const m = pick(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'push', 'splice']);
      const v = typed(WARR_KIND[ap], R); const i = Math.floor(R() * 3); const dc = Math.floor(R() * 2); const ins = R() < 0.5;
      log.push(`array ${ap}.${m}(${J(v)},${i},${dc})`);
      if (a && isFn(a[m])) { if (m === 'push' || m === 'unshift') a[m](v); else if (m === 'splice') a.splice(i, dc, ...(ins ? [v] : [])); else if (m === 'sort') a.sort((x: any, y: any) => (J(x) < J(y) ? -1 : 1)); else a[m](); }
    } else if (r < 0.92) { const k = 1 + Math.floor(R() * 3); const t = pick(['A', 'B', 'C']); log.push(`mutate items id=${k} title=${t}`); s.items.mutate(where('id', '===', k), update('title', t)); }
    else if (r < 0.96) { const idx = Math.floor(R() * 3); const which = R() < 0.5; log.push(`deleteByIndex/updateArrayItem items ${idx}`); if (which) inst.deleteByIndex('items', idx); else inst.updateArrayItem('items', idx, typed('item', R)); }
    else { const br = pick(['user', 'user.profile', 'obj', 'obj.map', 'items.0']); const v = typed(WPATHS[br], R); log.push(`replace ${br}=${J(v)}`); const bp = P(br); const parent = walkProxy(s, bp.slice(0, -1)); if (bp.length === 1) s[bp[0]] = v; else if (parent != null) parent[bp[bp.length - 1]] = v; }
  };
  if (R() < 0.15) { const n = 2 + Math.floor(R() * 3); log.push(`batch(${n})`); BATCHES++; inst.batch(() => { for (let i = 0; i < n; i++) safe(one, log); }); } else safe(one, log);
}

// ---- ops -------------------------------------------------------------------------
const VALS: any[] = [0, 1, 2, 7, -1, 'x', 'y', '', true, false, null, [], [1, 2], ['p', 'q', 'r'], {}, { a: 1 }, { name: 'N', age: 5, profile: { name: 'pp', tags: ['t'] } }, { id: 9, title: 'nine', done: true }, [{ id: 1, title: 'A', done: true }, { id: 4, title: 'D', done: false }]];
const clone = (v: any) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function doOp(s: any, ss: any, name: string, R: () => number, log: string[]): void {
  if (WELL) return doWellOp(s, ss, name, R, log);
  const pick = <X>(a: X[]) => a[Math.floor(R() * a.length)];
  const inst = ss.getStore(name);
  const one = (): void => {
    const r = R();
    const path = pick(PATHS); const val = clone(pick(VALS));
    const seg = path.join('.');
    const dotted = path.map(String).join('.');
    if (r < 0.34) { // proxy assign
      log.push(`assign ${dotted}=${J(val)}`);
      const parent = walkProxy(s, path.slice(0, -1));
      if (path.length === 1) s[path[0]] = val; else if (parent != null && (typeof parent === 'object' || typeof parent === 'function')) parent[path[path.length - 1]] = val;
    } else if (r < 0.44) { // delete
      log.push(`delete ${dotted}`);
      const parent = walkProxy(s, path.slice(0, -1));
      if (path.length === 1) delete s[path[0]]; else if (parent != null) delete parent[path[path.length - 1]];
    } else if (r < 0.52) { log.push(`assign-undefined ${dotted}`);
      const parent = walkProxy(s, path.slice(0, -1));
      if (path.length === 1) s[path[0]] = undefined; else if (parent != null) parent[path[path.length - 1]] = undefined;
    } else if (r < 0.62) { log.push(`setValue ${dotted}=${J(val)}`); s.setValue(dotted, val);
    } else if (r < 0.68) { log.push(`setValueObserve ${dotted}=${J(val)}`); s.setValueObserve(dotted, val);
    } else if (r < 0.86) { // array method through proxy
      const ap = pick(ARRAYS); const a = walkProxy(s, ap); const m = pick(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'push', 'splice']);
      const v = clone(pick([1, 5, 'z', { id: 20 + Math.floor(R() * 5), title: 't', done: R() < 0.5 }, [9]]));
      const i = Math.floor(R() * 3); const dc = Math.floor(R() * 2);
      log.push(`array ${ap.join('.')}.${m}(${J(v)},${i},${dc})`);
      if (a && isFn(a[m])) {
        if (m === 'push' || m === 'unshift') a[m](v); else if (m === 'splice') a.splice(i, dc, ...(R() < 0.5 ? [v] : [])); else if (m === 'sort') a.sort((x: any, y: any) => (J(x) < J(y) ? -1 : 1)); else a[m]();
      }
    } else if (r < 0.90) { // mutate
      const k = 1 + Math.floor(R() * 3); const t = pick(['A', 'B', 'C']);
      log.push(`mutate items id=${k} title=${t}`);
      s.items.mutate(where('id', '===', k), update('title', t));
    } else if (r < 0.94) { // typed helpers on the instance
      const idx = Math.floor(R() * 3); log.push(`deleteByIndex items ${idx}`);
      if (R() < 0.5) inst.deleteByIndex('items', idx); else { log.push(`updateArrayItem items ${idx}`); inst.updateArrayItem('items', idx, { id: 30 + idx, title: 'u', done: R() < 0.5 }); }
    } else { log.push(`replace-branch`); const br = pick(['user', 'user.profile', 'obj', 'obj.map', 'items.0']); const bp = P(br); const parent = walkProxy(s, bp.slice(0, -1));
      const v = br === 'items.0' ? { id: 1, title: 'R', done: R() < 0.5 } : br === 'user' ? { name: 'R', age: Math.floor(R() * 9), profile: { name: 'rp', tags: ['r'] } } : br === 'user.profile' ? { name: 'rp2', tags: [] } : br === 'obj' ? { map: { x: 2 }, sort: [1] } : { x: 5 };
      log.push(`replace ${br}=${J(v)}`);
      if (bp.length === 1) s[bp[0]] = v; else if (parent != null) parent[bp[bp.length - 1]] = v; }
  };
  const r0 = R();
  if (r0 < 0.15) { const n = 2 + Math.floor(R() * 3); log.push(`batch(${n})`); BATCHES++; inst.batch(() => { for (let i = 0; i < n; i++) safe(one, log); }); }
  else safe(one, log);
}
function safe(fn: () => void, log: string[]) { try { fn(); } catch (e) { log.push('  !threw ' + (e as Error).name); } }

// ---- driver ------------------------------------------------------------------------
// ISO=1: every consumer is run alone in its own fresh store (no siblings), replaying the same seed.
const ISO = process.env.ISO === '1';
const STRICT = process.env.STRICT === '1'; // skip stale claims for consumers whose last run read a missing path (untrackable by design)
const fails: Record<string, { steps: number[]; first: string }> = {};
let totalRuns = 0, checks = 0, opsDone = 0;

async function runSeed(seed: number, only: number | null): Promise<number> {
  const R = rng(seed);
  CID = 0; BATCHES = 0;
  const ss: any = new SignalStore(dev === '1' ? (fakeDev as any) : (undefined as any));
  if (dev === '1') ss.devActivation(true);
  const name = 'chk' + seed + '_' + (only ?? 'all');
  const s: any = ss.createStore(base(), name, { dependencyMode: mode });
  const consumers: Consumer[] = [];
  const act = (i: number) => only === null || i === only;
  const mk = () => consumers.push(makeConsumer(s, ss, name, R, act(CID)));
  const nInit = 6 + Math.floor(R() * 16);
  for (let i = 0; i < nInit; i++) mk();
  const raw = () => ss.getStore(name).returnStore();
  const nOps = 30;
  const oplog: string[] = [];
  const checkAll = async (step: number, subsetOnly: boolean) => {
    await tick();
    const st = raw();
    for (const c of consumers) {
      if (subsetOnly && R() < 0.5) continue;
      if (!act(c.id)) continue;
      if (STRICT && c.desc.startsWith('select') && BATCHES > c.born) continue; // documented: select() does not re-emit for writes inside batch()
      let got: string; try { got = c.get(); } catch (e) { got = 'THROW:' + (e as Error).name; }
      const want = c.truth(st);
      checks++;
      if (got !== want && !(STRICT && c.miss)) {
        const key = `${seed}:${c.id}:${c.desc}`;
        const f = (fails[key] ??= { steps: [], first: `step ${step} got=${got.slice(0, 80)} want=${want.slice(0, 80)} lastOps=${oplog.slice(-4).join(' ; ').slice(0, 300)}` });
        f.steps.push(step);
      }
    }
  };
  await checkAll(-1, false);
  for (let step = 0; step < nOps; step++) {
    if (R() < 0.12) mk(); // late consumer
    if (R() < 0.05 && consumers.length > 4) { const i = Math.floor(R() * consumers.length); consumers[i].dispose?.(); consumers.splice(i, 1); }
    doOp(s, ss, name, R, oplog); opsDone++;
    await checkAll(step, R() < 0.3);
  }
  await checkAll(nOps, false);
  for (const c of consumers) totalRuns += c.runs;
  for (const c of consumers) c.dispose?.();
  ss.destroyStore(name);
  return CID;
}
for (let seed = Number(sFrom); seed <= Number(sTo); seed++) {
  if (!ISO) await runSeed(seed, null);
  else { const n = await runSeed(seed, -1); for (let j = 0; j < n; j++) await runSeed(seed, j); }
}
const keys = Object.keys(fails).sort();
const summary = { root, mode, dev, iso: ISO, seeds: [Number(sFrom), Number(sTo)], ops: opsDone, checks, consumerRuns: totalRuns, staleConsumers: keys.length };
const body = JSON.stringify(summary) + '\n' + keys.map((k) => k + ' :: steps=' + fails[k].steps.join(',') + ' :: ' + fails[k].first).join('\n') + '\n';
if (outFile) await Bun.write(outFile, body); else console.log(body);
console.log(JSON.stringify(summary));
