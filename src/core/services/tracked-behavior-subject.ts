import { BehaviorSubject, Subscription, type Observer } from 'rxjs';

type NextObserver<T> = Partial<Observer<T>> | ((value: T) => void) | null;

/** BehaviorSubject that reports each live subscription (and its end) to the owning node. */
export class TrackedBehaviorSubject<T> extends BehaviorSubject<T> {
  constructor(
    initialValue: T,
    private readonly onSubscribe: () => void,
    private readonly onUnsubscribe: () => void
  ) {
    super(initialValue);
  }

  override subscribe(
    observerOrNext?: NextObserver<T>,
    error?: ((error: unknown) => void) | null,
    complete?: (() => void) | null
  ): Subscription {
    this.onSubscribe();
    let subscription: Subscription;
    try {
      // Runtime accepts the observer-object form too; rxjs only types it on the 1-arg overload.
      subscription = super.subscribe(observerOrNext as (value: T) => void, error, complete);
    } catch (error) {
      this.onUnsubscribe();
      throw error;
    }

    if (subscription.closed) {
      this.onUnsubscribe();
      return subscription;
    }

    let finalized = false;
    subscription.add(() => {
      if (finalized) return;
      finalized = true;
      this.onUnsubscribe();
    });
    return subscription;
  }
}
