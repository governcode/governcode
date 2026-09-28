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
2. **Filesystem is an allowlist** (Landlock). Writable: the project worktree (nothing, in
   Home) and the tool's own scratch directories. Read-only: system directories, the
   toolchain, and only the parts of the tool's configuration it needs. Everything else,
   including GovernCode's state, the tool's transcripts of other projects, other tools'
   files and the user's keyrings, is neither readable nor writable. Of `/dev`, only
   `null`, `zero` and `urandom`; no device ioctls, so no typing into a terminal.
3. **The tool's own settings, instructions and credentials are read-only**, so a run
   cannot widen what the tool auto-allows on its next launch. The worktree's own settings
   files are not loaded at all. After each turn `govd` removes any git hook or
   program-running git config (`core.fsmonitor`, `core.sshCommand`, filters, aliases...)
   the tool added, since those would run later outside the sandbox.
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

## Gates and standing allows: fewer questions, the same sandbox

A Gate asks you before a step. To keep that from turning into a click-fest, a Gate can also be
answered **"allow for this turn"** (the Controller's steps), **"for this Spec"** (a Runner's
steps in its own workspace) or **"for this project"** (remembered, listed in Settings and by
`gov allows`, revocable). **A standing allow only skips the question.** It never widens what the
sandbox lets a tool read, write, run or reach: every step, allowed by a rule or not, runs under
the same kernel-enforced policy, and every step is written to the Trace with the rule that let it
through.

What a standing allow can cover is deliberately narrow:

- **One kind of step.** For a command, its program and subcommand (`npm test`, `cargo build`);
  for edits, file edits (only where the sandbox already lets the tool write).
- **Plain commands only.** A command with shell syntax that could chain, substitute, redirect or
  hide a second command (`;` `&` `|` `$` backquotes `<` `>` quotes, globs, newlines) always asks.
- **Some programs always ask**, whatever you allowed: deleting (`rm`), privilege (`sudo`),
  network (`curl`, `ssh`), interpreters that run code given as an argument (`python`, `node`,
  `bash`...), publishing, and every `git` command (git obeys settings in the project's
  `.git/config`, which the AI can edit, and can run programs from them).
- **A Runner's allows are its own.** Allowing a step inside a Spec's workspace never covers the
  Controller's steps in your real project.
- **Delegation always asks.** Handing work to another AI is never covered.

Be aware of one honest limit: allowing a build or test command (`npm test`) means allowing
whatever the project's scripts say, and the AI can edit those scripts. The sandbox still bounds
what they can do; the Gate just no longer asks each time. Use "this turn" when in doubt.

**Quiet reads** (a setting, on by default): plain read-only commands that no project file can
steer (`ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `pwd`, `stat`, `du`, `df`, `which`)
run without a Gate. They are still sandboxed and still in the Trace. Turn it off in Settings to
be asked for everything.

## Local models: nothing to run, so nothing to sandbox

A local Runner (Ollama) is not a tool with a shell. govd sends it the text of the files in the
Spec's scope and gets back proposed file contents as JSON. govd then writes them itself, into the
Spec's workspace (govd's own state, which no AI can reach), after checking every path: inside the
write scope, not in `.git`, not through a symlink, not over a folder, at most 20 files of 256 KB.
One bad path refuses the whole answer, so nothing is half-written. The model never executes
anything, and the change still waits for your review. Its Limit is the machine's (how many at
once, how many minutes each), since there is no quota to measure.

## Known limits

- The tool can read its own credentials (it needs them) and reach any address on port
  443, so a misbehaving tool could send its own credentials away. The sandbox protects
  everything else; it cannot make a tool trustworthy with what it must hold.
- UDP is not restricted (DNS needs it); TCP is, by port but not by address.
- An expired login token cannot be refreshed inside the sandbox (credentials are
  read-only); run the tool once outside GovernCode to refresh it.
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
macOS: a default-deny Seatbelt profile. Windows: an AppContainer with a restricted token, in a
job object (no child escapes it, and it ends with the Runner). Both are planned together, with
the same priority, after Linux; neither ships without its own self-test.

## Protect mode (for trusted general-purpose agents)

GovernCode's own tools always use the deny-by-default sandbox above. `govern-sup` also has
a second mode for a different job: an agent that is trusted with the whole machine but
must not touch a few control files, for example the pipe it receives approvals through.

```json
{"version": 1, "mode": "protect", "protect": ["/run/user/1000/app/control.fifo"], "cwd": "/home/user"}
```

Everything is allowed except the listed paths. Because Landlock only grants, this is built
by granting full access to every entry beside the way from `/` down to each protected path,
and read-only listing on the way itself; nothing new can be created directly in those
directories, so keep protected files in a directory of their own. Verified: a protected FIFO
is refused both by path and through `/proc/<pid>/fd/N`, while writes elsewhere work.
`no_new_privs` is set, as the kernel requires, so `sudo` does not elevate inside.

**Protect mode is not a boundary against a determined agent.** It stops the agent from
touching the listed paths itself, but the agent keeps its Unix sockets and so can ask
unsandboxed services to act for it: verified, `systemd-run --user` from inside protect mode
writes a protected file. Terminal multiplexers and SSH are the same kind of route. Use it
to prevent accidents, never as the thing a security claim rests on; GovernCode's own AI
tools run in the default mode, where no Unix socket but the listed ones is reachable.
