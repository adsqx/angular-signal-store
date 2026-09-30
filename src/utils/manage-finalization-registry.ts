/** Creates weak references whose keys are reported to `onCleanup` once the value is collected. */
export class ManageFinalizationRegistry<T extends object, K = string> {
  private readonly registry?: FinalizationRegistry<K>;

  constructor(onCleanup: (key: K) => void) {
    if (typeof FinalizationRegistry !== 'undefined') this.registry = new FinalizationRegistry<K>(onCleanup);
  }

  create(value: T, key: K): WeakRef<T> {
    this.registry?.register(value, key);
    return new WeakRef<T>(value);
  }
}
