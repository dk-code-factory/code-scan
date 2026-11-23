Security review. Report only exploitable or likely-exploitable issues with a concrete path from
untrusted input (network, files, CLI args, env, IPC, user data) to the defect:
- injection of any kind (SQL/CQL, shell, path traversal, format strings, template, header/log injection)
- authentication/authorization gaps, privilege checks skipped on some path, TOCTOU on permissions
- memory corruption reachable from input: buffer overflows, integer overflow in size calculations,
  trusting length fields, use-after-free reachable from a request
- unsafe deserialization, unbounded allocations / recursion driven by input (resource exhaustion)
- secrets in code, weak crypto use, missing TLS verification, predictable randomness for security
Severity: critical = remote, no auth; high = remote with auth or local privilege gain; medium/low otherwise.
Skip hardening suggestions without a concrete attack path.
