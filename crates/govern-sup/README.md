# govern-sup

The sandboxing supervisor. See [docs/SANDBOX.md](../../docs/SANDBOX.md) for the invariants.

```
govern-sup run --policy POLICY.json -- PROGRAM [ARGS...]
govern-sup selftest [--json]
```

`run` applies the policy to itself and then execs the program in place, so the program
keeps govern-sup's pid, stdio and environment. Any govern-sup failure exits 125 and
nothing runs: there is no partial sandbox.

## Policy (version 1)

```json
{
  "version": 1,
  "read":  ["/usr", "/etc"],
  "write": ["/path/to/worktree"],
  "exec":  ["/usr/bin"],
  "tcp_connect": [443],
  "unix_connect": ["/run/systemd/resolve/io.systemd.Resolve"],
  "cwd": "/path/to/worktree"
}
```

- Paths are absolute. Unknown keys are an error.
- `read`: read-only. `write`: read, write, create, remove (not execute). `exec`: execute
  plus read.
- Missing `read`, `exec` or `unix_connect` paths are skipped with a warning; a missing
  `write` path or `cwd` is an error.
- `tcp_connect` defaults to `[443]`; binding TCP ports is always refused.
- `unix_connect` lists the only pathname Unix sockets the program may connect to
  (enforced from Landlock ABI 9; older kernels refuse all new Unix sockets).
