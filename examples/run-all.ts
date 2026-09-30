/** Runs every numbered example in a fresh process and fails on the first non-zero exit. */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((name) => /^\d\d-.*\.ts$/.test(name)).sort();

let failed = 0;
for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const result = spawnSync(process.execPath, [join(dir, file)], { stdio: 'inherit' });
  if (result.status !== 0) failed++;
}
console.log(failed === 0 ? `\nAll ${files.length} examples passed.` : `\n${failed} of ${files.length} examples failed.`);
process.exit(failed === 0 ? 0 : 1);
