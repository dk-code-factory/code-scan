Find defects that can crash the program, corrupt or leak data, or be exploited. Report only:
- Memory safety: use-after-free, double free, out-of-bounds read/write, uninitialized reads,
  dangling references/iterators, lifetime and ownership errors (objects destroyed while still used,
  captured references outliving their owner, moved-from use).
- Leaks: memory, file descriptors, sockets, locks/permits not released, tasks/futures/goroutines
  never joined or awaited, unbounded growth of caches/queues.
- Panics and crashes: null/nil dereference, unwrap/expect/assert/abort on input that can occur,
  unchecked index, division by zero, unhandled exceptions escaping where they terminate the process.
- Vulnerabilities: injection (SQL, shell, path traversal, format string), missing authn/authz checks,
  unsafe deserialization, integer overflow/underflow in sizes or lengths, trusting untrusted lengths.
- Correctness: logic errors, wrong conditions, off-by-one, data races and missing synchronization,
  wrong or swallowed error handling that loses data, broken invariants, wrong resource cleanup order.
Do not report style, naming, performance nits, missing tests, missing comments, or speculative
"could be a problem if" issues without a concrete triggering path in this code.
Severity: critical = remotely triggerable crash/RCE/data loss/corruption; high = crash, leak or
wrong result under realistic conditions; medium = needs unusual conditions; low = minor.
