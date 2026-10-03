// Main exports for the store
export { SignalStore } from './core/signal-store.service';
export type { WaitForStoreOptions } from './core/signal-store.service';
export { CreateStore } from './core/create-store.class';
export type { StoreProxy } from './interfaces/types';
export type { Draft } from './proxy/draft';
export { SIGNAL_STORE_DEVTOOLS } from './core/devtools-contract';
// Private API for the secondary entry points (`/jsnq`), which import the core by package name so
// there is a single registry at runtime. Not for application use.
export { registerJsnqBridge as ɵregisterJsnqBridge } from './core/jsnq-contract';
export { logger as ɵlogger } from './utils/logger';
export type { AngularStoreDevtools, DevToolsEvent } from './core/devtools-contract';
// Type-safe selectors API
export type { Signal } from '@angular/core';

// Re-export for backward compatibility
export { SignalStore as default } from './core/signal-store.service';
