# The sandbox (`govern-sup`)

Every AI coding tool GovernCode runs (a Controller or a Runner) is started by
`govern-sup`, a small Rust supervisor, inside a sandbox that denies by default. The point
is one guarantee: **an AI tool cannot approve its own Gate, spend around a Limit, or reach
the daemon except through the channels it was given.** A same-user process with a file
mode is not a boundary; this sandbox is.

## Invariants

1. **Only the channels it was given.** A sandboxed tool reports through stdin, stdout and
   stderr; the Controller's GovernCode MCP server may also connect to its restricted per-turn
   socket. That socket offers project tools, never Gate answers, Accept or undo. Every other
   inherited descriptor is closed before the tool starts, so a file or socket opened outside
   the sandbox cannot be carried in. No tool can connect to govd's user-facing RPC socket.
2. **Filesystem is an allowlist** (Landlock). Writable: the Controller's project worktree
   (read-only in Home or a report turn), or a Runner's Spec scope, plus the tool's own run
   home, scratch directories and permitted login-refresh file. Read-only: system directories, the
   toolchain, and only the parts of the tool's configuration it needs. Everything else,
   including GovernCode's control state, the tool's transcripts of other projects, other tools'
   files and the user's keyrings, is neither readable nor writable. Of `/dev`, only
   `null`, `zero`, `random` and `urandom`; no device ioctls, and seccomp refuses `TIOCSTI` and
   `TIOCLINUX` on any descriptor, so no typing into a terminal. Every policy path is opened
   once, and the rule is built on that descriptor: a write path may not pass through any
   symlink, and a read or exec path only through symlinks root owns (`/bin -> usr/bin`), so a
   link planted by an earlier run cannot redirect a grant.
3. **Every run has a fresh home.** Its caches, settings, memory and rules are discarded
   afterwards, so they cannot widen what a later run auto-allows. The login is the only
   writable state shared between runs; Antigravity also shares helper programs read-only.
   Tools may refresh the login (Grok's is read-only), and govd copies a replaced login
   back as bytes, without parsing it. A Controller may bring personal instructions by
   explicit opt-in, linked read-only; Claude Code's selected behaviour settings are copied,
   excluding credential helpers and `env`. Claude Code does not load worktree settings;
   Codex starts with a fresh GovernCode home. After each Controller turn `govd` removes any
   git hook or program-running git config (`core.fsmonitor`, `core.sshCommand`, filters, aliases...)
   the tool added, since those would run later outside the sandbox.
4. **Network is limited** (Landlock TCP rules): outbound TCP to ports 443 (and 80 only if a
   policy asks) and nothing else; no binding.
5. **No local IPC out, except what the policy lists.** The session bus, the keyring service
   and the daemon are all Unix sockets. From Landlock ABI 9 the kernel refuses connecting to
   any pathname Unix socket except those in the policy's `unix_connect` list (in practice
   the system DNS resolver's and a Controller's per-turn tool socket; each entry must be a
   socket file, never a folder), and scoping blocks abstract sockets. On older kernels
   seccomp refuses creating `AF_UNIX` sockets at all, so listed sockets remain unreachable. Stream
   `socketpair` keeps working. seccomp also refuses System V shared
   memory, message queues and semaphores, and POSIX message queues.
6. **No reaching other processes.** seccomp denies `ptrace`, `process_vm_readv/writev`,
   `pidfd_getfd` and `io_uring_setup`; Landlock denies ptrace-level access to processes
   outside the sandbox and scopes signals and abstract Unix sockets.
7. **No privilege gain.** `no_new_privs` is set; setuid binaries do not elevate. Changing a
   file's owner or its extended attributes is refused.
8. **Descendants are collected before normal supervisor exit.** The tool runs as a child of
   `govern-sup`, which stays outside the sandbox as its subreaper. When the tool exits or the
   supervisor handles a stop signal, it kills and reaps descendants, detached or not, and
   refuses a clean result if collection fails. Killing the supervisor itself with SIGKILL
   can interrupt this collection; see Known limits below.
9. **Fail closed.** If the kernel lacks what a rule needs, `govern-sup` refuses to start the
   tool and says which rule and why. There is no "run unsandboxed" switch. The self-test
   proves each rule on your machine, against a control run without the sandbox, before any
   tool starts.

## Gates and standing allows: fewer questions, the same sandbox

A Gate asks you before a step. **How often is yours to choose** (Settings › Gates, or
`gov level`), and the sandbox is exactly the same at every level:

- **Relaxed:** only steps on the always-ask list below ask, and handing work to a paid Runner.
  Everything else runs without a question and is recorded in the Trace.
- **Balanced** (the default): each new kind of step asks; answer "allow for this project" and
  that kind stops asking in that project. The always-ask list still asks every time.
- **Strict:** every step asks, except quiet reads (if on) and rules you made.

AI tools rarely run a bare command: they run `cd app && npm test 2>&1 | tail -20`. GovernCode
reads such a command part by part, at `&&`, `||`, `;`, `|` and newlines, treats `cd`, `2>&1` and
redirection to `/dev/null` as nothing, and judges each remaining part on its own; the example is
simply `npm test`. Anything it cannot read safely makes the whole command ask: substitution
(`$(...)`, backquotes, `$VAR`), subshells, background jobs, redirection into a file, input from a
file, globs, comments.

To keep that from turning into a click-fest, a Gate can also be
answered **"allow for this turn"** (the Controller's steps), **"for this Spec"** (a Runner's
steps in its own workspace) or **"for this project"** (remembered, listed in Settings and by
`gov allows`, revocable). **A standing allow only skips the question.** It never widens what the
sandbox lets a tool read, write, run or reach: every step, allowed by a rule or not, runs under
the same kernel-enforced policy, and every step is written to the Trace with the rule that let it
through.

What a standing allow can cover is deliberately narrow:

- **One kind of step.** For a command, its program and subcommand (`npm test`, `cargo build`);
  for edits, file edits (only where the sandbox already lets the tool write).
- **Readable commands only.** A command is covered only if every part of it is; anything that
  could substitute, redirect into a file or hide a command (above) always asks.
- **The always-ask list**, at every level, whatever you allowed: deleting (`rm`), privilege
  (`sudo`), network (`curl`, `ssh`...), installing packages (`npm install`, `pip install`,
  `cargo add`...), interpreters that run code given as an argument (`python`, `node`, `bash`...),
  launchers that run another program (`env`, `xargs`, `timeout`...), another AI coding tool
  (`claude`, `codex`, `agy`, `gemini`, `grok`, `ollama`, `aider`...), publishing, and every `git`
  command that changes the repository or reaches the network (commit, push, pull, fetch, reset,
  checkout, config...), and package-manager commands other than running the project's scripts or
  listing (`npm test`, `npm run build` and `npm ls` are kinds; `npm i`, `npm it` and a bare `yarn`
  install, so they ask). Reading the repository (`git status`, `diff`, `log`, `show`, with their
  plain options; anything else, such as `--output` or `--open-files-in-pager`, asks) is a kind
  like any other. It runs inside the sandbox, though git may run a program its own config names
  (a diff driver, a pager), as `npm test` runs the project's scripts; the .git guard puts back
  anything a turn changed in `.git`.
- **A Runner's allows are its own.** Allowing a step inside a Spec's workspace never covers the
  Controller's steps in your real project.
- **Handing work to a paid Runner asks,** unless the project's Crew card follows the approved
  plan and an item you approved covers it (one handoff per item). govd decides this inside the
  handoff itself, however the Controller reached it. Handing work to a local model (no quota) is
  a kind of step like any other. A Controller may throw away a Spec it proposed (also decided by
  govd); accepting one is always yours.

The Controller's `crew`, `spec_status`, `conversation_read` and `project_notes` calls do not
each ask at a Gate. Handoffs, follow-ups and discards go through govd's own decision path;
`spec_cancel` stops a run without an approval question, keeping partial work for review. A
report-only wake turn cannot do any of those mutations or write project notes, and its project
filesystem is read-only. An opted-in limit continuation is different: it may continue work,
under the usual Gates and sandbox.

A Runner's Gates belong to its Spec, not the Controller turn or starting terminal. Every
client can list and answer them; they wait up to an hour, then deny, and any left waiting deny
when the round ends. Spec-scoped allows end with that round too. Async Specs can outlive a
Controller turn, and a follow-up reuses the copy and scope after another Gate and Limit check;
neither changes the sandbox boundary or applies the diff to the project.

Be aware of one honest limit: allowing a build or test command (`npm test`) means allowing
whatever the project's scripts say, and the AI can edit those scripts. The sandbox still bounds
what they can do; the Gate just no longer asks each time. Use "this turn" when in doubt.

**Quiet reads** (a setting, on by default): plain read-only commands that no project file can
steer (`ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `pwd`, `stat`, `du`, `df`, `which`,
`find` with tests only) run without a Gate, and only with the options each is known to read
with: any other option (`tail -f`, `rg --pre`, `grep -f`...) or a special file (`/dev`,
`/proc`, `/sys`) asks. An interpreter asked only its version (exactly `node --version`,
`python3 -V`, `ruby -v`...) is a quiet read too; with any other argument it asks. A Grok Runner's own read tools (reading a file, searching, listing a
folder) are quiet reads on the same terms: one that reaches a special place, or that GovernCode
cannot check, always asks. They are still sandboxed and still in the Trace. Turn it off in
Settings to be asked for everything.

## Local models: nothing to run, so nothing to sandbox

A local Runner (Ollama) is not a tool with a shell. govd sends it the text of the files in the
Spec's scope and gets back proposed file contents as JSON. govd then writes them itself, into the
Spec's workspace (govd's own state, which no AI can reach), after checking every path: inside the
write scope, not in `.git`, not through a symlink, not over a folder, at most 20 files of 256 KB.
One bad path refuses the whole answer, so nothing is half-written. The model never executes
anything, and the change still waits for your review. Its Limit is the machine's (how many at
once, how many minutes each), since there is no quota to measure.

## Optional child resource ceilings (development)

A version 1 deny-by-default supervisor policy may include this block:

```json
"child_limits": {
  "cpu_seconds": 2,
  "address_space_bytes": 67108864,
  "open_files": 32
}
```

These are example fixture values, not an accepted profile for a real agent. All three fields
are required when the block is present, and the block must be an object with named fields.
Values must be positive finite native integers; arrays, null, unknown or duplicate fields,
fractions, overflow and the unlimited sentinel are refused.
Omitting the block preserves inherited limits. Protect mode rejects it.

After sandbox setup, only the forked child lowers its soft and hard `RLIMIT_CPU`, `RLIMIT_AS`
and `RLIMIT_NOFILE` values. Each becomes the smaller of its inherited value and the requested
ceiling. Exact readback is required before exec; a failed syscall or mismatch prevents the
target from starting. The supervisor's own limits remain unchanged. An unprivileged child
cannot raise its lowered hard ceilings, and descendants inherit them.

CPU seconds count each process's CPU time, not elapsed wall time or the run's total CPU use.
Address-space bytes bound each process's virtual mappings, not resident memory or the run's
total memory. `open_files` bounds descriptor numbers per process; it does not close existing
descriptors or bound pipe output. These Linux semantics follow [getrlimit(2)](https://man7.org/linux/man-pages/man2/getrlimit.2.html).

This foundation provides no aggregate resource, process-count or output-byte bound, and does
not repair the supervisor hard-kill lifetime gap below. Real agents may reserve large virtual
address ranges and fail an otherwise generous address-space ceiling. No production agent
profile selects these ceilings yet; registry-agent discovery remains disabled. Native fixture
tests require an installed C compiler and static libc support, and use separate wall watchdogs.

## Optional child syscall restrictions (development)

A version 1 deny-by-default policy can opt into this fixed restriction block:

```json
{
  "child_restrictions": { "deny_network": true, "deny_chmod": true },
  "tcp_connect": [],
  "tcp_bind": [],
  "unix_connect": []
}
```

Both named Boolean fields are required and must be `true`. Partial blocks, arrays, null,
false values, unknown fields and duplicates are refused. Protect mode rejects the block.
All network grants must be empty before filesystem resolution, including Unix socket paths
that do not exist. Omitting `tcp_connect` keeps its normal `[443]` default and conflicts with
the restriction; callers must explicitly provide `[]`. Omitting the whole restriction block
preserves existing behavior.

The child's seccomp filter denies `socket`, `socketpair`, `io_uring_enter`, `io_uring_register`
and native chmod-family syscalls with `EPERM`. The existing `io_uring_setup`, ownership and
extended-attribute denials remain. Internal pipes and ordinary granted file I/O still work.
The restriction supports native little-endian Linux LP64 x86_64 and aarch64; unsupported
targets fail closed. Simulated filter tests do not establish live acceptance on another target.

This denies socket creation, not every possible source of network traffic. Arbitrary socket-
backed stdio, externally supplied descriptors, existing polling rings or mappings, network
devices, remote filesystems and cooperating external processes remain outside this primitive.
A future probe launcher must supply fresh trusted stdio and its own narrow, credential-free
filesystem and environment setup. Blocking chmod-style operations does not freeze inode modes:
creation modes, `umask`, unlink/replacement and kernel clearing of set-ID bits remain possible.
This block does not repair supervisor hard-kill cleanup or enable registry-agent execution.

## Passive ACP probe contexts (development)

The standalone probe-context allocator creates scratch directories and policy inputs; it
starts no process and has no production caller. A trusted caller must supply an existing,
dedicated, owner-only scratch parent. Allocation checks directory ownership, exact `0700`
modes and identities without following symlink components. Each context has separate empty
working, home, configuration, cache, data, state, runtime and temporary directories, plus an
empty search directory. Its environment contains only those paths and fixed locale values;
no host environment, login files or shared Runner configuration is copied.

Optional setup cancellation uses a signal from `createAcpProbeAbortController()`. The allocator
rejects unregistered or altered signal shapes without invoking user accessors. Cancellation
waits for pending filesystem operations and never deletes a successfully returned context.

PATH and the system XDG search lists point to the empty directory. Filesystem inputs grant
the eight writable leaves and read access to the empty search directory, with no executable,
parent, project, artifact-store or system-directory grants. These inputs are an incomplete
policy fragment, not a runnable sandbox or proof of credential isolation. A future launcher
still needs reviewed executable/runtime access, context and receipt revalidation, fresh
trusted stdio, the native restrictions, resource/output bounds and owned lifetime containment.

Successful contexts are retained and expose no cleanup method. Transport closure, process
exit, cancellation or elapsed time cannot authorize their deletion. Only failed setup before
a context is returned may attempt bounded, nonrecursive rollback of recorded empty directories;
detected replacements or unexpected contents cause retention. Node's path operations cannot
make deletion conditional on inode identity, so malicious same-user mutation, privileged
actors and hostile storage remain outside the allocator's trust boundary. The private runtime
directory redirects scratch use; it does not establish a login-session lifecycle.

## Fixture-only PID namespace lifetimes (development)

An explicit `probe-lifetime-fixtures` Cargo feature builds a native fixture driver and tests;
ordinary builds and production `run` dispatch do not include the new lifetime module. It
creates a fresh unprivileged user/PID namespace using `clone3`, with a trusted supervisor as
namespace PID 1 and a separate verifier outside it. Admission stays closed until single-ID
mappings, control ownership, capability removal and parent-death checks are established.
Unprivileged mapping rules freeze supplementary groups; their inherited representation is
verified, rather than cleared. The target still requires the existing Landlock/seccomp policy
and child ceilings. Control descriptors are closed before exec, and an additional filter
denies namespace creation or joining by the target.

Stop requests and deadlines signal the owned init pidfd. A private native termination value
is constructed only after exact kernel reaping of this invocation's namespace init. Linux
namespace teardown precedes init reaping; sending SIGKILL, observing target exit or closing
stdio is insufficient. This ordering follows the [kernel's namespace teardown invariant](https://github.com/torvalds/linux/blob/v6.12/kernel/pid_namespace.c#L225).
The fixture's independent guard receives a duplicate init pidfd before
target admission. It exercises finite descendants, detached process groups, supervisor death
and verifier death without relying on inherited host `/proc` scans.

An opt-in transport fixture carries the verifier's actual termination result to a Node test
owner over a dedicated channel, separate from ACP stdout/stderr. Only trusted, locally built
fixture programs participate. Proof/control descriptors are closed before target execution.
A bounded 32-byte invocation-matching record remains a candidate until genuine channel EOF
and a clean verifier-exit check by the outer guard. Truncation, extra bytes, channel errors,
deadline expiry or producer death leave the result unproven. The guard's independent reap
cannot repair missing verifier evidence, and a matching identifier on agent stdout grants no
authority. The fixture stop adapter closes the owned control endpoint rather than signalling
an external process group; ordinary ACP shutdown behavior is unchanged.

This does not provide a production proof channel or authorize deleting returned probe contexts.
Loss of the verifier loses its proof; failed or timed-out observation leaves termination
unproven. Kernel teardown can be delayed by uninterruptible tasks. Unsupported namespace,
mapping, pidfd or wait operations fail closed, with no execution fallback. Actual fixtures
establish acceptance only on the tested host; other architectures and kernels remain unverified.
The primitive adds no aggregate CPU, memory or task bound and does not establish credential or
network isolation. No real registry agent is launched by this feature. Logical framing tests
and an explicitly run native transport harness provide different evidence; ordinary package
tests do not launch namespace fixtures merely because a feature binary is present.

## Passive ELF program-header evidence (development)

A standalone synchronous inspector examines supplied bytes for an explicit Linux x86_64 or
aarch64 platform. It copies only the supplied byte view into private memory, refusing shared,
resizable or detached backing. It accepts a conservative ELF64 little-endian layout with at
most 256 program headers and a 128 MiB artifact bound. The program table and file ranges must
fit that snapshot; load memory ranges are checked for overflow. Extended program-header counts
and unsupported segment types are refused.

Its positive result is only `no-interpreter-or-dynamic-segments`: every declared program header
in the supported layout was inspected and none was `PT_INTERP` or `PT_DYNAMIC`. Both ET_EXEC
and ET_DYN may yield this evidence. Sections, instructions, relocations, runtime dependencies
and custom loading behavior are not inspected. This evidence does not establish full ELF
validity, execution compatibility, credential isolation or absence of dependencies, and verifies
no checksum or receipt identity.

The inspector has no production caller and changes no installer acceptance, Runner eligibility
or filesystem grants. Future probing still needs receipt-to-byte and exact-execution binding,
reviewed runtime access, a narrow policy, context association and native lifetime proof transport.
No real artifact is executed by this inspection.

## Known limits

- Existing Runner policies allow `chmod` (npm and git set file modes), and Landlock does not mediate it, so a
  tool can change the permission bits of a file it can name by path, even outside its
  allowlist. It cannot read or write such a file; it could make one unreadable to you.
- If `govern-sup` itself is killed with SIGKILL, its descendant collection is interrupted.
  The direct tool receives a parent-death signal unless it cleared that registration;
  detached descendants can survive. A handled stop gives the tool 3 seconds to end, then
  collection has up to 30 seconds to kill and reap descendants. ACP transport shutdown has
  a last-resort process-group SIGKILL timer, and discovery's supplied transport is asked to
  close after 100 ms. That can kill the supervisor before collection finishes. Supervisor
  and stdio closure alone therefore do not prove that every descendant died. Production
  registry-agent discovery remains disabled pending independent lifetime containment and
  descendant-death evidence before its temporary directories can be removed.
- The tool can read its own credentials (it needs them) and reach any address on port
  443, so a misbehaving tool could send its own credentials away. Reading them is a quiet read,
  so no Gate asks first, and a Runner could repeat them in its words or write them into its
  changes (you would see that in the diff). The sandbox protects everything else; it cannot make
  a tool trustworthy with what it must hold. Keeping a Runner's login out of its own reach is
  planned with GovernCode's secrets storage.
- Existing Runner policies do not restrict UDP (DNS needs it); TCP is restricted by port,
  not by address. The optional child syscall block above instead denies socket creation.
- A tool that refreshes its login during a run keeps it (govd copies the new login back as it
  is). Grok's login is read-only inside a run, so when it expires, `gov connect grok` signs it in
  again.
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
