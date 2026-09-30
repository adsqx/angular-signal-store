/**
 * 05 - Devtools: the optional event bus.
 *
 * Run: bun examples/05-devtools.ts
 *
 * In an Angular app you register the adapter with `provideSignalStoreDevtools()` and switch
 * emission on with `signalStore.devActivation(true)`. Here the same pieces are wired by hand so
 * the example runs without a browser. The package ships the event bus, not a panel.
 */
import { SIGNAL_STORE_DEVTOOLS, SignalStore } from '@adsq/angular-signal-store';
import { DevService, provideSignalStoreDevtools } from '@adsq/angular-signal-store/devtools';
import { check, section } from './_check';

section('the provider');
const provider = provideSignalStoreDevtools() as { provide: unknown; useClass: unknown };
check('binds the token to DevService', [provider.provide === SIGNAL_STORE_DEVTOOLS, provider.useClass === DevService], [true, true]);

section('events flow only while devtools are active');
const devtools = new DevService();
const signalStore = new SignalStore(devtools); // Angular does this for you through the token
const events: string[] = [];
devtools.action$.subscribe((event) => {
  if (event) events.push(`${event.type} ${event.storeName} ${(event.payload as { path?: string } | undefined)?.path ?? ''}`.trim());
});

type State = { user: { name: string }; list: number[] };
const store = signalStore.createStore<State>({ user: { name: 'Ann' }, list: [1] }, 'demo');
const draft = store as unknown as State;

draft.user.name = 'quiet';
await Promise.resolve();
check('nothing is emitted while inactive', events, []);

signalStore.devActivation(true);
draft.user.name = 'Ada';
draft.list.push(2);
store.user.name(); // the first tracked read of a path registers a computed
await Promise.resolve();
check('writes, array operations and computed registration are reported', events, [
  'SET_VALUE_OBSERVE demo user.name',
  'ARRAY_OPERATION demo list',
  'COMPUTED_STORE_UPDATE demo user.name',
]);

section('the history stream');
const history: string[] = [];
devtools.readAction$.subscribe((event) => event && history.push(event.type));
check('readAction$ is a BehaviorSubject: it replays the latest event', history, ['COMPUTED_STORE_UPDATE']);

section('switching off');
signalStore.devActivation(false);
draft.user.name = 'silent again';
await Promise.resolve();
check('no further events', events.length, 3);

console.log('\n05-devtools: all checks passed');
