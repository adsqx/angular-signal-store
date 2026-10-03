/** v2 `/devtools` entry: the current DevService adapter, provided under the v2 token. */
import type { Provider } from '@angular/core';
import { SIGNAL_STORE_DEVTOOLS } from './signal-store';
import { DevService } from '../../src/devtools/dev.service';

export { DevService };
export function provideSignalStoreDevtools(): Provider {
  return { provide: SIGNAL_STORE_DEVTOOLS, useClass: DevService };
}
