// Bundle size of the current store vs v2, same method for both (esbuild --bundle --minify; Angular and RxJS external).
// Run from the repo root: node v2_new/tools/size.mjs
import * as esbuild from 'esbuild';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { resolve } from 'node:path';
const R = resolve(import.meta.dirname, '../..');
const size = async (contents, jsnqExternal) => {
  const r = await esbuild.build({ stdin: { contents, resolveDir: R, loader: 'ts' }, bundle: true, minify: true, format: 'esm', write: false,
    logLevel: 'silent', tsconfig: R + '/tsconfig.json', external: ['@angular/*', 'rxjs', 'rxjs/*', ...(jsnqExternal ? ['@adsq/jsnq', '@adsq/jsnq/*'] : [])] });
  const b = r.outputFiles[0].contents;
  return [b.length, gzipSync(b, { level: 9 }).length, brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length];
};
const kb = (n) => (n / 1000).toFixed(1) + ' kB';
console.log('| Bundle | Minified | Gzip | Brotli |\n| --- | ---: | ---: | ---: |');
for (const [name, dir] of [['current', './src'], ['v2', './v2_new/src']]) {
  const rows = [
    ['core, @adsq/jsnq external', `import * as a from '${dir}/index.ts'; console.log(a);`, true],
    ['core + the jsnq path engine it uses', `import * as a from '${dir}/index.ts'; console.log(a);`, false],
    ['core + /jsnq entry (queries)', `import * as a from '${dir}/index.ts'; import * as b from '${dir}/jsnq.ts'; console.log(a, b);`, false],
  ];
  for (const [label, code, ext] of rows) {
    const v = await size(code, ext);
    console.log(`| ${name}: ${label} | ${kb(v[0])} | ${kb(v[1])} | ${kb(v[2])} |`);
  }
}
