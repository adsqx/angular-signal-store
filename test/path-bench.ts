/** Baseline for the path layer. Run: bun test/path-bench.ts */
import { PathUtils } from '../src/utils/path-utils';
import { parentPathOfCore, resolveVersionPathCore } from '../src/utils/path-core';

const HOT = ['user.profile.name', 'board.rows.12.cells.3.value', 'a.b.c.d.e', 'items.0.tags.2'];
const bench = (name: string, iterations: number, fn: (i: number) => void) => {
  for (let i = 0; i < 2000; i++) fn(i);              // warmup
  const samples: number[] = [];
  for (let s = 0; s < 3; s++) {
    const t = performance.now();
    for (let i = 0; i < iterations; i++) fn(i);
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  console.log(`${name.padEnd(46)} ${samples[1]!.toFixed(3).padStart(9)} ms / ${iterations} ops`);
};

bench('normalizePath (hot, cache-friendly)', 200_000, (i) => { PathUtils.normalizePath(HOT[i % HOT.length]!); });
bench('normalizePath (unique, cache-hostile)', 200_000, (i) => { PathUtils.normalizePath(`a.b${i}.c`); });
bench('splitNormalizedPath (hot)', 200_000, (i) => { PathUtils.splitNormalizedPath(HOT[i % HOT.length]!); });
bench('splitNormalizedPath (unique)', 200_000, (i) => { PathUtils.splitNormalizedPath(`a.b${i}.c`); });
bench('isValidPath (hot)', 200_000, (i) => { PathUtils.isValidPath(HOT[i % HOT.length]!); });
bench('getParentPath (hot)', 200_000, (i) => { parentPathOfCore(HOT[i % HOT.length]!); });
bench('resolveVersionPath (hot)', 200_000, (i) => {
  resolveVersionPathCore(HOT[i % HOT.length]!, { dependencyMode: 'exact', bumpNumericParent: true });
});
