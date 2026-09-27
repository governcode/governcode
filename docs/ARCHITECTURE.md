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

## Protocol

JSON-RPC 2.0, one object per line. `hello` returns the protocol number, a feature list and
the sandbox status; clients check features, not versions. Methods: `project.list`,
`project.new`, `project.open`, `controller.set`, `ask` (streams `event` notifications),
`gate.list`, `gate.answer`, `trace.list`. Parameters are validated with Zod schemas in
`packages/protocol`.

## Roadmap

See the README. Phase 1 adds the `delegate` tool (over MCP, on its own socketpair), Specs,
Checkpoints with guarded undo, and the first measured Runner.
