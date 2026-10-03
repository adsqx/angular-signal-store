/**
 * Runs against the BUILT package (npm run build first): the secondary entry points must share the
 * core's registry and injection token. Source-level tests cannot see this, since they load one copy
 * of every module. Run: node test/package-entrypoints.test.mjs
 */
import '@angular/compiler'; // the package is partially compiled; plain Node needs the JIT linker
import { SignalStore, SIGNAL_STORE_DEVTOOLS } from '@adsq/angular-signal-store';
import { provideSignalStoreDevtools } from '@adsq/angular-signal-store/devtools';

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log(`PASS ${msg}`); else { console.error(`FAIL ${msg}`); failures++; } };
const { where, update } = await import('@adsq/jsnq');

const ss = new SignalStore(undefined);
const before = ss.createStore({ users: [{ id: 1, active: true, score: 0 }] }, 'pkg-before');
let message = '';
try { before.users.mutate(where('active', '===', true), update('score', 1)); } catch (e) { message = String(e); }
ok(message.includes('@adsq/angular-signal-store/jsnq'), 'without the /jsnq entry, mutate names the missing import');

await import('@adsq/angular-signal-store/jsnq');
const s = ss.createStore({ users: [{ id: 1, active: true, score: 0 }, { id: 2, active: false, score: 0 }] }, 'pkg-after');
s.users.mutate(where('active', '===', true), update('score', 5));
ok(s.users()[0].score === 5 && s.users()[1].score === 0, 'mutate works after importing the /jsnq entry');
ok(s.users.$query(where('active', '===', false)).length === 1, '$query works after importing the /jsnq entry');
const live = s.users.$liveQuery(where('score', '>', 1));
ok(live().length === 1, '$liveQuery works after importing the /jsnq entry');
ok(provideSignalStoreDevtools().provide === SIGNAL_STORE_DEVTOOLS, 'the /devtools entry provides the core injection token');

if (failures) { console.error(`\n${failures} package check(s) failed`); process.exit(1); }
console.log('\nAll package entry-point checks passed.');
