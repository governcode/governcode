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

In a project, the Claude Controller gets GovernCode's tools (`delegate`, `crew`,
`spec_status`) from a small MCP server that runs inside its sandbox and can reach only a
socket `govd` opens for that one turn. That socket offers no Gate answers and no undo.

`delegate` measures the Runner's usage and checks the Limit (unknown means held; finished
Specs keep counting until the provider's counter catches up), then builds the Runner's
workspace **in govd's own state directory**, out of every AI tool's reach: the project's
committed HEAD, exported without filters, with its own git directory for snapshots. The
Runner runs sandboxed with write access only to the Spec's scope (checked for symlinks).
Snapshots hash raw bytes with git plumbing under a config that runs no program, so no repo
filter, hook or diff driver ever executes. A change outside the scope is never offered.
`gov accept` applies exactly the reviewed after-state of each changed file, bound to the
snapshot ids stored on the Spec, and only if the project still holds the before-state;
otherwise nothing is applied.

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
