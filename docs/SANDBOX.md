# The sandbox (`govern-sup`)

Every AI tool GovernCode runs (a Controller, a Runner, later a Module) is started by
`govern-sup`, a small Rust supervisor, inside a sandbox that denies by default. The point
is one guarantee: **an AI tool cannot approve its own Gate, spend around a Limit, or reach
the daemon except through the one channel it was given.** A same-user process with a file
mode is not a boundary; this sandbox is.

## Invariants

1. **One channel.** A sandboxed process talks to `govd` only through file descriptors
   `govern-sup` hands it (its stdin/stdout pipes and, later, one inherited socketpair for
   MCP). It cannot open new connections to `govd`.
2. **Filesystem is an allowlist** (Landlock). Writable: the project worktree and the tool's
   own session/cache directories. Read-only: system directories, the toolchain, the tool's
   own configuration. Everything else, including GovernCode's state, other tools' files
   and the user's keyrings, is invisible to writes and reads.
3. **The tool's own permission settings are read-only**, so a run cannot widen what the
   tool auto-allows on its next launch.
4. **Network is limited** (Landlock TCP rules): outbound TCP to ports 443 (and 80 only if a
   policy asks) and nothing else; no binding.
5. **No local IPC out, except what the policy lists.** The session bus, the keyring service
   and the daemon are all Unix sockets. From Landlock ABI 9 the kernel refuses connecting to
   any pathname Unix socket except those in the policy's `unix_connect` list (in practice
   only the system DNS resolver's), and scoping blocks abstract sockets. On older kernels
   seccomp refuses creating `AF_UNIX` sockets at all. Inherited sockets and stream
   `socketpair` keep working.
6. **No reaching other processes.** seccomp denies `ptrace`, `process_vm_readv/writev`,
   `pidfd_getfd` and `io_uring_setup`; Landlock denies ptrace-level access to processes
   outside the sandbox and scopes signals and abstract Unix sockets.
7. **No privilege gain.** `no_new_privs` is set; setuid binaries do not elevate.
8. **Fail closed.** If the kernel lacks what a rule needs, `govern-sup` refuses to start the
   tool and says which rule and why. There is no "run unsandboxed" switch.

## Known limits

- UDP is not restricted (DNS needs it); TCP is.
- A binary the tool writes into its worktree can still be loaded through the dynamic loader
  (`ld.so ./file`): Landlock checks execute on `execve`, not on memory mapping.

## Self-test

`govern-sup selftest` starts a probe inside a real sandbox and requires every attack to
fail and every needed permission to work. It runs in CI on Linux and at install, and
`govd` will not start AI tools until it has passed on this machine. The attacks include
the one that motivated this design: a sandboxed process trying to write an approval into
its own input channel by path, or to open a fresh connection to the daemon.

## Platforms

Linux: Landlock (ABI 4 or newer for TCP rules, 6 or newer for scoping) + seccomp.
macOS: a default-deny Seatbelt profile (planned for phase 2). Windows: not supported.
