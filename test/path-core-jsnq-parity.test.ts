/**
 * Equivalence probe for the eight path-core functions that look like they duplicate
 * @adsq/jsnq/data-engine. Each pair is compared on the same inputs; any divergence is
 * reported, because a pair that diverges must NOT be replaced by delegation.
 *
 * Run: bun test/path-core-jsnq-parity.test.ts
 */
import { getBySegmentsCore } from '../src/utils/path-core';
import {
  splitPathCore,
  getByPathCore,
  setByPathCore,
  pathExistsCore,
  resolveParentAndKeyCore,
  getParentSegmentsCore,
  cloneJsonCore,
} from './path-core-reference';
import {
  splitJsonPath,
  readJsonPath,
  writeJsonPathValue,
  hasJsonPath,
  getJsonBySegments,
  resolveJsonParentAndKey,
  getJsonParentSegments,
  cloneJsonData,
  createJsonPathPlanFromSegments,
} from '@adsq/jsnq/core/data-engine';

type Divergence = { pair: string; input: string; core: string; jsnq: string };
const divergences: Divergence[] = [];
const checked: Record<string, number> = {};

const show = (value: unknown): string => {
  try {
    if (value === undefined) return 'undefined';
    return JSON.stringify(value, (_k, v) => (v === undefined ? '__undefined__' : v)) ?? String(value);
  } catch {
    return '<unserializable>';
  }
};

/** Runs both sides, catching throws so "throws" counts as an observable outcome. */
const compare = (pair: string, input: string, core: () => unknown, jsnq: () => unknown): void => {
  checked[pair] = (checked[pair] ?? 0) + 1;
  let coreOut: string;
  let jsnqOut: string;
  try { coreOut = show(core()); } catch (error) { coreOut = `THROWS(${(error as Error).message.slice(0, 40)})`; }
  try { jsnqOut = show(jsnq()); } catch (error) { jsnqOut = `THROWS(${(error as Error).message.slice(0, 40)})`; }
  if (coreOut !== jsnqOut) divergences.push({ pair, input, core: coreOut, jsnq: jsnqOut });
};

const PATHS = [
  'user.name',
  'a.b.c.d.e.f.g.h',
  'items.0.tags.2',
  'items[0].tags[2]',
  'root',
  '',
  'a..b',
  '.leading',
  'trailing.',
  'a.__proto__.b',
  'constructor',
  'weird key.with space',
  'a.0',
  '0',
  'deep.1.2.3.value',
];

const makeFixture = () => ({
  user: { name: 'Ann', age: 0, empty: '', nope: false, nothing: null },
  items: [{ tags: ['x', 'y', 'z'] }, { tags: [] }],
  deep: { 1: { 2: { 3: { value: 'found' } } } },
  root: 'top',
  a: { b: { c: { d: { e: { f: { g: { h: 'deep' } } } } } } },
});

// ---------------------------------------------------------------- 1. split
for (const path of PATHS) {
  compare('splitPathCore <-> splitJsonPath', path, () => splitPathCore(path), () => splitJsonPath(path));
}

// ---------------------------------------------------------------- 2. read by path
for (const path of PATHS) {
  const fixture = makeFixture();
  compare('getByPathCore <-> readJsonPath', path, () => getByPathCore(fixture, path), () => readJsonPath(fixture, path));
}
compare('getByPathCore <-> readJsonPath', 'falsy root ""', () => getByPathCore('', 'a'), () => readJsonPath('', 'a'));
compare('getByPathCore <-> readJsonPath', 'falsy root 0', () => getByPathCore(0, 'a'), () => readJsonPath(0, 'a'));

// ---------------------------------------------------------------- 3. read by segments
const SEGMENT_SETS: string[][] = [
  ['user', 'name'],
  ['items', '0', 'tags', '1'],
  ['missing', 'deeper'],
  [],
  ['user', 'nothing', 'further'],
  ['deep', '1', '2', '3', 'value'],
];
for (const segments of SEGMENT_SETS) {
  const fixture = makeFixture();
  compare(
    'getBySegmentsCore <-> getJsonBySegments',
    segments.join('/') || '<empty>',
    () => getBySegmentsCore(fixture, segments),
    () => getJsonBySegments(fixture, segments),
  );
}

// ---------------------------------------------------------------- 4. exists
for (const path of PATHS) {
  const fixture = makeFixture();
  compare('pathExistsCore <-> hasJsonPath', path, () => pathExistsCore(fixture, path), () => hasJsonPath(fixture, path));
}

// ---------------------------------------------------------------- 5. write (compare resulting tree)
const WRITE_PATHS = ['user.name', 'user.fresh', 'brand.new.deep.path', 'items.0.tags.1', 'items.2.tags.0', '', 'a.__proto__.x'];
for (const path of WRITE_PATHS) {
  compare(
    'setByPathCore <-> writeJsonPathValue',
    path,
    () => { const f = makeFixture(); setByPathCore(f, path, 'WROTE'); return f; },
    () => { const f = makeFixture(); writeJsonPathValue(f, path, 'WROTE'); return f; },
  );
}

// ---------------------------------------------------------------- 6. resolve parent + key
for (const path of ['user.name', 'items.0.tags.1', 'missing.deep.key', 'user.name.further', '', 'root']) {
  const fixture = makeFixture();
  compare(
    'resolveParentAndKeyCore <-> resolveJsonParentAndKey',
    path,
    () => { const r = resolveParentAndKeyCore(fixture, path); return { key: r.key, segments: r.segments, parentFound: r.parent !== undefined }; },
    () => { const r = resolveJsonParentAndKey(fixture, path); return { key: r.key, segments: r.segments, parentFound: r.parent !== undefined }; },
  );
}

// ---------------------------------------------------------------- 7. parent segments
for (const segments of SEGMENT_SETS) {
  compare(
    'getParentSegmentsCore <-> getJsonParentSegments',
    segments.join('/') || '<empty>',
    () => getParentSegmentsCore(segments),
    () => getJsonParentSegments(createJsonPathPlanFromSegments(segments)),
  );
}

// ---------------------------------------------------------------- 8. clone
const sparse: unknown[] = [1, 2, 3];
delete sparse[1];
const cyclic: Record<string, unknown> = { name: 'cycle' };
cyclic['self'] = cyclic;
const CLONE_CASES: Array<[string, unknown]> = [
  ['plain nested', { a: { b: [1, 2, { c: 3 }] } }],
  ['primitives', { n: 0, s: '', b: false, nul: null }],
  ['undefined value', { u: undefined }],
  ['sparse array', sparse],
  ['date', { when: new Date(0) }],
  ['function property', { fn: () => 1 }],
  ['cyclic', cyclic],
  ['null', null],
  ['scalar', 42],
];
for (const [label, value] of CLONE_CASES) {
  compare('cloneJsonCore <-> cloneJsonData', label, () => cloneJsonCore(value), () => cloneJsonData(value));
}

// ---------------------------------------------------------------- report
const byPair = new Map<string, Divergence[]>();
for (const d of divergences) {
  if (!byPair.has(d.pair)) byPair.set(d.pair, []);
  byPair.get(d.pair)!.push(d);
}

console.log('pair                                                inputs  divergences  verdict');
for (const pair of Object.keys(checked)) {
  const found = byPair.get(pair) ?? [];
  const verdict = found.length === 0 ? 'EQUIVALENT — safe to delegate' : 'DIVERGES — keep local';
  console.log(`${pair.padEnd(52)}${String(checked[pair]).padStart(5)}${String(found.length).padStart(12)}  ${verdict}`);
}

if (divergences.length > 0) {
  console.log('\nDivergences:');
  for (const [pair, items] of byPair) {
    console.log(`\n  ${pair}`);
    for (const d of items) console.log(`    input ${JSON.stringify(d.input)}\n      core: ${d.core}\n      jsnq: ${d.jsnq}`);
  }
}

const equivalent = Object.keys(checked).filter((p) => !byPair.has(p));
console.log(`\n${equivalent.length} of ${Object.keys(checked).length} pairs are equivalent.`);
