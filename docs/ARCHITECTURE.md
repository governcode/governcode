# Architecture

GovernCode runs on your own machine. There is no hosted service.

```
 gov (CLI) ─┐                                     ┌─ Claude Code ─┐
 Dashboard ─┼── JSON-RPC over a Unix socket ── govd ── govern-sup ─┤               ├─ each in its own
 Pager    ──┘   (phase 3: paired, remote)     (TS)      (Rust)     └─ more Runners ┘  sandbox
                                                │
                                   Trace: SQLite, append-only
```

## Pieces

| Piece | Language | Job |
|---|---|---|
| `govd` | TypeScript (Node 22.18+) | Projects, the Controller, Gates, the Trace, the RPC server. Refuses to start any AI tool until the sandbox self-test has passed on this machine. |
| `govern-sup` | Rust | The only thing that starts AI tools. Applies the sandbox, then execs the tool. See [SANDBOX.md](SANDBOX.md). |
| `gov` | TypeScript | The command line; a thin client of `govd`. |
| `@governcode/protocol` | TypeScript + Zod | The wire contract shared by `govd` and every client. |

## A turn, end to end

1. `gov ask "..."` sends `ask` to `govd` over its Unix socket (a 0700 directory; the
   sandbox cannot open Unix sockets, so every connection is the user).
2. `govd` writes a policy for this turn (the project folder writable, or nothing writable
   in Home; the tool's own settings read-only; TCP to port 443 only) and starts
   `govern-sup run --policy … -- claude …`.
3. `govern-sup` applies Landlock, seccomp and `no_new_privs`, then execs Claude Code in
   place. Claude Code loads only the user's own settings, never the project's.
4. Claude Code streams events on stdout. A permission request becomes a **Gate**: `govd`
   records it, shows the exact request (sorted, ASCII-escaped JSON) to the user's terminal,
   and waits. Allow runs exactly that input; deny, or the asker disconnecting, denies.
5. Every step lands in the **Trace**: an append-only SQLite log that clients read.

## Delegation (phase 1)

In a project, the Controller (Claude Code or Codex) gets GovernCode's tools (`delegate`,
`crew`, `spec_status`) from a small MCP server that runs inside its sandbox and can reach
only a socket `govd` opens for that one turn. That socket offers no Gate answers and no
undo. Each call is a Gate the user answers; for Codex, govd answers only the approval for
the GovernCode tool call Codex just announced, and declines any other server's.

`delegate` measures the Runner's usage and checks the Limit (unknown means held; finished
Specs keep counting until the provider's counter catches up), then builds the Runner's
workspace **in govd's own state directory**, out of every AI tool's reach: the project's
committed HEAD, exported without filters, with its own git directory for snapshots. The
Runner runs sandboxed with write access only to the Spec's scope (checked for symlinks).
Snapshots hash raw bytes with git plumbing under a config that runs no program, so no repo
filter, hook or diff driver ever executes. A change outside the scope is never offered.
`gov accept` applies exactly the reviewed after-state of each changed file, bound to the
snapshot ids stored on the Spec, and only if the project still holds the before-state;
otherwise nothing is applied. It never writes or follows a symlink (a dangling one
included): new content is staged beside each file with `O_NOFOLLOW`, every file is checked
again, and only then renamed into place. Accept and undo wait while a Controller turn is
running in that project, since a running tool could swap a folder for a symlink mid-write.

## Settings: Limits and models

The user's settings live in govd's own state (0600, out of every AI tool's reach) and change
only through the user's socket (`gov reserve`, `gov runner`, `gov spec-models`, the Dashboard's
Settings), each change written to the Trace. Per Runner and per usage window, a **reserve**
(0-90%, default 10) is held back; the Limit gate uses it at once. Each Runner may have a
**default model and effort**, and one policy says how far a Controller may depart from them
per Spec: `free` (its pick), `within` (the default model, effort never heavier), or `defaults`.
The Controller's pick is a request: the Spec records what ran and, when a setting changed it,
why. The `crew` tool tells the Controller the defaults and the policy before it asks.

A Runner can also have a **counted budget** (`gov budget`, or Settings in the Dashboard): a cap
per window (5-hour, daily, weekly, monthly) in the provider's unit, tokens where its driver
reports them and turns (one per Spec) otherwise. govd counts what its own Runners use, in its
state (`counted.json`, 0600), and turns the count into the same percent readings a usage report
gives, so the Limit gate, in-flight holds and the Dashboard treat it like any other window. A
window starts at the first run counted after the previous one ended and resets that long after.
Each run is written down (synced to disk) before it starts and settled when it ends; a run left
open by a crash is counted at the next start as a turn with unknown tokens. A count file that
cannot be read or trusted holds every budget it covers and is never overwritten.
The count is always fresh, but it is **counted by GovernCode only**: use outside GovernCode (the
user's own sessions, other apps) is invisible to it, so the budget should sit below the real plan,
and it keeps no reserve unless one is set. A token budget holds if a run reported no tokens. When
the provider has its own usage report too, both are read and every reading is checked, so the
stricter one decides; if either cannot be read, the Runner is held. A provider with neither a
report nor a budget is held, unless the user explicitly opts it in to run unmetered (no Limit,
nothing counted). Local models have no quota: their Limit is the machine's (`gov local N M`: at
most N local Specs at once, each stopped after M minutes).

## Proposing a project from Home

At Home the Controller's turn socket offers one tool, `propose_project`. govd checks the
name and folder as it would for `project.new` (free name, nothing there yet, no denied
folder, symlinked parents resolved), keeps the proposal, and shows it with Create and
Cancel. Only `proposal.answer create`, from the user, makes the folder, after the same
checks again. Proposing creates nothing, so it has no Gate of its own.

## Checkpoints of Controller turns

Before each Controller turn in a git project, `govd` snapshots the project's tracked and
unignored files into a store of its own (the same plumbing-only git as Specs), and again
after. A turn that changed files records a Checkpoint; `gov undo T-n` restores the
before-state of exactly those files, all or nothing, only where the project still holds the
after-state, and only once.

## Protocol

JSON-RPC 2.0, one object per line. `hello` returns the protocol number, a feature list and
the sandbox status; clients check features, not versions. Methods: `project.list`,
`project.new`, `project.open`, `controller.set`, `ask` (streams `event` notifications),
`gate.list`, `gate.answer`, `trace.list`, `spec.list`, `spec.diff`, `spec.accept`,
`spec.discard`, `turn.list` (a project's Checkpoints: id, time, files, whether undone),
`turn.undo`, and `watch`: after it, the connection also receives every Trace append
(`{kind: "trace", event}`) and a `{kind: "gates"}` nudge whenever a Gate opens or is
settled, so clients update without polling. Parameters are validated with Zod schemas in
`packages/protocol`.

## Roadmap

See the README. Phase 1 adds the `delegate` tool (over MCP, on its own socketpair), Specs,
Checkpoints with guarded undo, and the first measured Runner.
