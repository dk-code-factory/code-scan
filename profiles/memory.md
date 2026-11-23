Memory and resource handling review. Report only:
- use-after-free, double free, dangling pointers/references/iterators/string_views/spans
- lifetime bugs in async code: references captured by continuations/lambdas/coroutines that outlive
  the referenced object; objects destroyed while an operation on them is still pending
- out-of-bounds access, uninitialized memory, wrong size arithmetic
- leaks of memory, fds, sockets, locks, semaphores/permits, timers, background tasks never awaited
- exception/error paths that skip cleanup or release twice
Each finding needs the concrete sequence (allocation → release → later use, or acquire → path that
never releases). Skip style and generic "consider RAII" advice.
