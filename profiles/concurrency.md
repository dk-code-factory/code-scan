Concurrency review. Report only:
- data races: shared mutable state accessed without the lock/atomic that protects it elsewhere
- deadlocks: inconsistent lock order, waiting while holding a lock the waker needs, blocking calls on
  reactor/event-loop threads
- atomicity violations: check-then-act across yields/awaits/unlocks, iterator invalidation across
  a suspension point
- lost wakeups, missing cancellation/abort handling that leaves operations hanging, unawaited futures
  whose failure is lost
Each finding needs the two concrete interleaving paths. Skip generic advice.
