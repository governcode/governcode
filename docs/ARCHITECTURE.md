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
| `govern-sup` | Rust | Starts and supervises AI coding tools under the sandbox. Local models receive text through Ollama instead. See [SANDBOX.md](SANDBOX.md). |
| `gov` | TypeScript | The command line; a thin client of `govd`. |
| `@governcode/protocol` | TypeScript + Zod | The wire contract shared by `govd` and every client. |

## A turn, end to end

1. `gov ask "..."` sends `ask` to `govd` over its user-facing Unix socket (0600 in a 0700
   directory; sandboxed tools cannot connect to it). One Controller turn runs at a time per
   project, or at Home.
2. `govd` writes a policy for this turn (the project folder writable, or nothing writable
   in Home or a report-only wake turn; a fresh tool home with its GovernCode login linked
   in; TCP to port 443 only) and starts
   `govern-sup run --policy … -- claude …`.
3. `govern-sup` applies Landlock, seccomp and `no_new_privs`, then starts the tool under
   supervision. Claude Code loads no settings file by default, never the project's settings;
   personal setup is an explicit opt-in. Codex can be the Controller too.
4. Claude Code streams events on stdout. A permission request becomes a **Gate**: `govd`
   records it, shows the exact request (sorted, ASCII-escaped JSON) to the user's terminal,
   and waits, unless Gate settings, a standing allow or an approved plan cover it. Allow runs
   exactly that input; deny, or the asker disconnecting, denies the Controller's request.
   A Runner's Gates belong to its Spec instead (below).
5. Turns, tool steps, Gates and state changes land in the **Trace**: an append-only SQLite
   log that clients read.

## Project memory

`govd` owns project memory in the Trace, separate from a tool's disposable home and the
repository. A turn receives notes (up to 4,000 characters, with every version kept), a
project record built without AI from recent Specs, Checkpoints and project allows, and
recent conversation items as JSON. They are information in the message, not new instructions
in the system prompt.

The conversation budget is `settings.memory.conversationChars` (16,000 by default). Selection
tries the latest user message, latest reply and first user message since the last reset, then
the rest newest to oldest; what fits is presented in conversation order. Items that do not fit
are omitted whole, never shortened. Replies identify their Controller's provider and model,
and failed turns are marked as partial. Wake and automatic continuation messages identify
GovernCode as their author and do not count as the first user message.

`conversation_read` pages through earlier items, or reads a long item in parts. It cannot
reach before `conversation.reset`. Switching providers requires a sharing choice: without
consent the new Controller sees only its own provider's conversation and Specs, and cannot
read or overwrite shared notes. Reset starts a new conversation; it does not delete the Trace
or project notes.

## Delegation (phase 1)

In a project, the Controller (Claude Code or Codex) gets GovernCode's tools from a small
MCP server inside its sandbox, connected to a restricted socket `govd` opens for that one
turn. It offers `delegate`, `crew`, `plan`, `spec_status`, `spec_cancel`, `spec_followup`,
`spec_discard`, `project_notes` and `conversation_read`, never Gate answers, Accept or undo.
Read calls and notes updates do not each open a Gate. Handoffs, follow-ups and discards are
decided inside govd; a game plan has its own user answer. A paid handoff asks unless the Crew
card's plan policy lets one approved item cover it. For Codex, govd accepts only a matching,
announced GovernCode MCP call and declines other servers' approvals; accepting that tool call
does not bypass the checks inside it. Runners receive no delegation tools. The per-turn
pathname socket needs Landlock ABI 9; on ABI 6–8 the sandbox blocks all new Unix sockets.

`delegate` measures the Runner's usage and checks the Limit (unknown means held; a finished
Spec keeps counting until the provider's report has caught up with it: a reading taken 15
minutes after it finished that shows usage has risen, or the vendor confirming that the
window it ran in has reset; 2 hours at most), then builds the Runner's
workspace **in govd's own state directory**, granting that Runner access only to its copy:
the project as the user has it now (the last commit with the user's uncommitted edits; a new file only when an
accepted Spec wrote it or the Spec's scope names it, never one that looks like a secret or holds
a private key), read one folder at a time without following any link, refused over 2 GB or
200,000 files, with its own git directory for snapshots. The
Runner runs sandboxed with write access only to the Spec's scope (checked for symlinks).
Snapshots hash raw bytes with git plumbing under a config that runs no program, so no repo
filter, hook or diff driver ever executes. A change outside the scope is never offered.
`gov accept` applies exactly the reviewed after-state of each changed file, bound to the
snapshot ids stored on the Spec, and only if the project still holds the before-state;
otherwise nothing is applied. `spec.diff` returns the before/after snapshot ids with its
content; `spec.accept` must supply those same ids, and rejects a newer round before writing
anything. Clients without reviewed snapshot ids cannot accept. It never writes or follows a symlink (a dangling one
included): new content is staged beside each file with `O_NOFOLLOW`, every file is checked
again, and only then renamed into place. Accept and undo wait while a Controller turn is
running in that project, since a running tool could swap a folder for a symlink mid-write.

### Spec lifetime and completion delivery

`delegate` defaults to `mode: async`: once admitted, it returns the Spec id while govd owns
the run. `mode: wait` waits for the result (600 seconds by default, configurable from 10 to
3,300); a timeout or the Controller turn ending stops only the wait, not the Spec. Each Spec
has its own copy and stop signal. The default caps are three running Specs per project and
two per Runner across govd, in `settings.specs`. Caps refuse a handoff rather than queue it;
local-model caps and the provider's combined usage Limit apply as well.

Runner Gates are owned by govd, listed for every client and answerable after the starting
Controller turn ends. They are denied after an hour without an answer or when that round
ends; Spec-scoped allows also end with the round. `spec_cancel` (or the user's `spec.cancel`)
stops a running Spec and keeps partial changes for review. `spec_followup` starts a fresh
Runner session on a finished Spec's existing copy and scope, after another Gate and Limit
check. Follow-ups require a retained copy and a Spec waiting for review, failed or cancelled;
they cannot widen the scope or reopen an accepted or discarded Spec. The original
before-snapshot stays, so the diff and Accept cover every round; the last Runner summary
is quoted as data, not trusted as instructions.

Completion delivery is recorded on the Spec. An async result is `pending`; a turn reporting
it makes it `claimed`, then `delivered` on success or `pending` again on failure. Reading a
finished Spec with `spec_status` acknowledges it unless a reporting turn already claims it;
a wait call receiving the result acknowledges it directly. Cancellation, disposal or turning
completion reports off can mark delivery `disposed`.

The Crew card chooses `wake: auto`, `tell` or `off`. `auto` starts a read-only report turn when
the project Controller is idle and a client has connected with `watch {wake: true}` (the
Dashboard). `tell` folds finished Spec ids and states into the user's next message; `off`
suppresses completion delivery. Wake turns use govd's fixed text, read results through
`spec_status`, and cannot delegate, follow up, cancel, discard or write notes. A user message
arriving during an unattended turn goes next. The last wake-capable client disconnecting
stops the unattended turn. Failed delivery waits for the user's next message rather than
starting another wake turn.
Starting a new Runner round clears suppression and reporting claims for the earlier completion,
so that round can report normally even if a turn reporting the old result fails later.

On restart, unfinished Specs are marked failed and their copies snapshotted for review;
interrupted Controller turns are closed too. Pending completion reports wait for the user's
next message. Restart does not itself restart those Specs or launch completion turns.

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
reports them and turns (one per Runner round) otherwise. govd counts what its own Runners use,
in its state (`counted.json`, 0600), and turns the count into the same percent readings a usage report
gives, so the Limit gate, in-flight holds and the Dashboard treat it like any other window. A
window starts at the first run counted after the previous one ended and resets that long after.
Each run is written down (synced to disk) before it starts and settled when it ends; a run left
open by a crash is counted at the next start as a turn with unknown tokens. A count file that
cannot be read or trusted holds every budget it covers and is never overwritten. If a required
count cannot be written, that Runner does not start.
The count is always fresh, but it is **counted by GovernCode only**: use outside GovernCode (the
user's own sessions, other apps) is invisible to it, so the budget should sit below the real plan,
and it keeps no reserve unless one is set. A token budget holds if a run reported no tokens. When
the provider has its own usage report too, both are read and every reading is checked, so the
stricter one decides; if either cannot be read, the Runner is held. A provider with neither a
report nor a budget is held (running one unmetered is not offered). Local models have no quota: their Limit is the machine's (`gov local N M`: at
most N local Specs at once, each stopped after M minutes).

For provider-reported windows, `owed.json` (0600) keeps in-flight reservations and the amounts
still owed by finished rounds. Admission includes every running reservation and reconciles
finished amounts per window; one rise in a provider's reading is not credited to several Specs.
Claims are saved before a Runner starts, become debits when it ends, and survive a restart.
Open claims left by a crash become debits on load. An unreadable, invalid or unwritable owed
file holds metered Runners; local models are unaffected. Recovery from a broken store requires
fixing the file and restarting govd; removing it also clears the accounting it retained.
These are admission checks against reports that can lag, not a hard cap on what an
already-running provider can spend.

## Usage-limit recovery

Recovery is derived from Specs and the Trace: held Specs, failed Runner rounds marked
`limited`, and a project's latest failed Controller turn with a reported usage limit. A
newer turn, conversation reset or Controller change makes an earlier turn ineligible. Driver
limit reports and Limits crossed during a running Spec preserve the reset time when known;
if several windows block admission, the latest blocking reset is used, or no reset if any
blocking window has an unknown time. No provider reset time is guessed.

Claude Code's driver detects rejected rate-limit events and terminal limit errors, with a
60-second inactivity timeout after a rejected window that pauses while a Gate is pending.
Codex detects usage-limit and rate-limit errors and reads resets from account rate-limit
snapshots. The ACP driver treats error `-32003` as a rate limit with no known reset time;
Grok therefore needs a manual resume.

The user can resume now, opt in at reset, turn that choice off, or clear the recovery record.
`settings.recovery.autoResume` is off by default; turning it on arms newly limited items with
a known future reset. `recovery.set`, `recovery.resume` and `recovery.clear` carry the item's
`since`, so a stale choice cannot act on a newer limit episode. A cleared record does not
accept or discard a Spec. A resume attempt is recorded before work starts, so a crash cannot
silently repeat the same at-reset choice.
The sweep rechecks each choice before attempting it and again after usage measurement;
clearing, disabling or replacing the choice during that wait prevents the old attempt from
starting work.

Resuming a Spec checks the current Crew card, caps, model policy and freshly measured Limit
again. A held Spec gets a fresh project copy; a Runner-limited Spec continues in its existing
copy with the original before-snapshot. If model, effort or budget changed, automatic recovery
waits for a manual resume. A still-blocking Limit leaves it limited. A Controller continuation
is a new `ask` with `continuationOf`, using project memory rather than the old provider session.

The single-flight recovery sweep runs every 15 seconds and after a wake-capable watch connects,
only while such a client is present. Automatic Controller continuations are authored by govd
and may work within the Crew card and normal Gates; they are not report-only wake turns. The
last wake-capable client leaving stops both unattended Controller turns and automatically
resumed Specs. Such a Spec stays limited for a new user choice. Ordinary async Specs continue
independently of the client that started them.

## ACP registry discovery

`acp.search` and `acp.inspect` are read-only user-socket operations, exposed through `gov acp`.
They fetch only the fixed official ACP registry URL. `acp-catalog.ts` rejects redirects, sends
no credentials, caps the streamed body at 2 MiB, times out after ten seconds, and validates UTF-8
before decoding. Concurrent reads share a request; validated snapshots are cached in memory for
ten minutes. Explicit refresh failures invalidate that cache. Results include the source, fetch
time and SHA-256 of the catalog bytes. Failed HTTP responses release their body and request.

`acp-registry.ts` validates the published v1 shape, with bounded fields and at most 512 agents.
Decoded metadata is immutable. Search is bounded; inspection picks only an exact platform.
Plans require an explicit distribution when more than one is available, a binary SHA-256 and
recognized archive format, or an explicitly pinned npm/uv package matching the advertised version.
Unsafe sources, executable paths, environment overrides and unsupported encodings are refused.
Plans describe advertised argv; no command in them is executed.

Eligibility comes from local safety profiles, never registry fields. It requires the exact
agent/version/platform, verified isolation and permission behavior, subscription authentication,
and ready counted or provider usage accounting. The OpenCode descriptor is blocked: its ACP
implementation's HTTP listener conflicts with no-bind, and its runtime isolation has not been
verified here. All registry agents remain ineligible. There is no production probe launcher,
sign-in, Runner adapter, or Controller-tool exposure for this feature.

`acp.install`, `acp.installed` and `acp.install.cancel` are user-socket operations. Installation
refreshes the fixed catalog, rebuilds the exact host plan, and matches the inspection fingerprint
before opening a mandatory, nonrememberable Gate. That binding covers the catalog source/digest
and every recipe field; fetch time is provenance rather than recipe identity. Client-supplied
URLs, checksums and storage paths are rejected. Plans, standing allows, quiet reads and relaxed
mode cannot approve this Gate. Denial, cancellation, requester disconnect and shutdown abort work;
shutdown waits for store cleanup. Operation starts and outcomes enter the Trace; interrupted
operations are recorded on restart and never resumed.

The executor stores only SHA-256 raw ELF64 binaries for the current Linux architecture. It
does not unpack archives or run npm/uv. Download uses direct HTTPS with connection-time public
address validation and pinning, a dedicated agent, no redirects or proxy settings, strict full
response framing, a 128 MiB cap, a sixty-second total limit and ten-second inactivity limit.
The store walks directories through descriptors without symlinks, uses owner-only modes and a
cross-process lock, verifies the hash and ELF header, syncs bytes and receipt, and publishes
atomically, then rechecks published identities and evidence before reporting success. Listing and
reuse verify every stored sibling's receipt and artifact, including beyond the result limit.
Cleanup captures entries before checking ownership, retaining detected replacements; lock release
retires its name before deletion so a new cooperative owner's lock cannot be removed.
Ambiguous leftovers, stale locks and
tampering are refused, never automatically adopted, stolen or repaired. A receipt's version is
registry-advertised; no artifact is executed for verification.

The owner-only store must remain inaccessible to untrusted actors, including AI tools. Node
does not provide inode-conditional rename or deletion. A raced replacement can reach the
publication name before verification rejects it. Checksums and identity checks do not authenticate
state against a malicious same-user owner, or prevent that owner from replacing private capture
entries immediately before deletion. The store makes no absolute guarantee against that actor.

`acp-probe.ts` is a separate supplied-`AcpRpc` discovery foundation tested with invented RPC
and stream fixtures.
It decodes bounded v1 initialize/session metadata, gives configOptions precedence over legacy
selectors, rejects every incoming client request, limits notifications, and closes on timeout,
cancellation or malformed metadata. One monotonic deadline covers all requests; runtime closure
must be confirmed before a report is returned. Optional session creation requires the caller's
fresh-directory assertion, which is not a filesystem or isolation check. This module provides
neither a launcher nor proof of authentication, subscription, metering, isolation or arbitrary
descendant termination. Reported metadata and stored bytes do not confer Runner eligibility.

The ACP transport has an internal, opt-in `outputBudget: { maxBytes }` prerequisite for future
discovery. Configuration is checked before spawn: one named data field, a positive safe integer,
at most 1 MiB. Omission preserves the existing Runner transport behavior. A shared lifetime
counter admits raw stdout and stderr bytes before decoding, line scanning, JSON parsing or
stderr retention. Exactly reaching the ceiling is allowed; a chunk that would exceed it is
discarded whole, including any valid message inside it. Admission therefore depends on chunk
boundaries, and messages already delivered cannot be withdrawn.

The opted-in transport copies at most 4,096 admitted raw stderr bytes into its diagnostic tail;
cutting a UTF-8 character at the tail boundary may produce a replacement character. A breach
latches a fixed local error, rejects pending and future requests, suppresses further protocol
delivery and writes, destroys the pipes, and requests shutdown once. Discovery observes that
local failure through cleanup and reports `output-budget-exceeded`; peer error text or codes
cannot manufacture that status. Unconfirmed transport closure still raises a cleanup error.

This bounds bytes admitted to transport decoding and parsing, rather than exact process memory
or CPU use. Delivered chunk allocations, OS buffering and work already dispatched to callbacks
remain outside that bound. Output failure does not prove supervisor exit or descendant death;
the existing shutdown timers and lifetime gap remain. No production profile selects this option,
and no registry-agent launcher is enabled by it.

The native supervisor also has a fixed, opt-in `child_restrictions` primitive requiring
`deny_network: true` and `deny_chmod: true` together. Its strict map-only parser rejects
contradictory TCP/Unix grants before resolving paths. The existing seccomp builder adds
unconditional socket/socketpair, io_uring entry/registration and architecture-specific
chmod-family denials before its ABI-dependent branches. Existing policies and generators do
not select the block. Native fixture tests cover its enforcement; older-ABI filter simulations
are not live kernel evidence. This neither validates arbitrary inherited stdio nor supplies
credential-free homes, immutable file modes or independently owned descendant lifetimes.

A separate passive ACP probe-context allocator returns frozen directory identities, an explicit
environment and narrow filesystem inputs. It copies no credentials, grants no executable access
and has no production caller. Working, HOME, XDG and temporary directories are distinct, empty
and owner-only; PATH and system XDG searches point to an empty leaf. Successful allocations are
retained with no cleanup method. Failed setup can attempt bounded rollback, retaining detected
replacements or unexpected contents. This foundation neither launches an agent nor establishes
descendant death, runtime compatibility or production credential-isolation acceptance.

The explicit `probe-lifetime-fixtures` native build feature tests a separate PID-namespace
lifetime primitive, excluded from production dispatch. A trusted namespace PID 1 admits a
restricted target only after mappings, capability removal and parent-death registration; an
outside verifier owns its init pidfd and exact wait. A private termination value requires
reaping that init after kernel namespace teardown. Independent finite fixtures exercise
descendants and verifier loss. No production proof transport or context deletion is wired;
unconfirmed teardown and loss of the verifier retain uncertainty. Existing Runner supervision
and its hard-kill limit remain unchanged.

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
the sandbox status; clients check features, not versions. Methods, by area:

- projects and turns: `project.list`, `project.new`, `project.open`, `proposal.answer`,
  `controller.set`, `ask` (streams `event` notifications), `conversation.reset`,
  `context.state`, `context.share`, `notes.get`, `notes.set`, `crew.get`, `crew.set`,
  `plan.answer`;
- Gates and rules: `gate.list`, `gate.answer`, `allows.list`, `allows.revoke`;
- Specs and Checkpoints: `spec.list`, `spec.diff`, `spec.accept`, `spec.discard`, `spec.cancel`, `turn.list`
  (a project's Checkpoints: id, time, files, whether undone), `turn.undo`;
- Limits, settings and tools: `limits.list`, `settings.get`, `settings.set`, `tools.list`,
  `connect.start`, `connect.input`, `connect.cancel`, `tools.disconnect`;
- official ACP catalog inspection and artifact storage: `acp.search`, `acp.inspect`, `acp.install`,
  `acp.installed`, `acp.install.cancel`;
- recovery: `recovery.list`, `recovery.set`, `recovery.resume`, `recovery.clear`; Controller
  turns continue through `ask` with `continuationOf`, not `recovery.resume`;
- the record: `trace.list`, and `watch`: after it, the connection also receives every Trace
  append (`{kind: "trace", event}`) and a `{kind: "gates"}` nudge whenever a Gate opens or is
  settled, so clients update without polling. `watch` defaults to `wake: false`; `wake: true`
  declares that the client can show unattended work and permits wake turns and opted-in
  at-reset recovery while it stays connected.

The current feature list is `projects`, `trace`, `ask`, `gates`, `home`, `delegate`, `specs`,
`watch`, `parallel-specs`, `recovery`, `acp-registry` and `acp-install`. Parameters are validated with Zod schemas in
`packages/protocol`. `settings.set` preserves saved top-level keys omitted by the request,
so older clients do not erase settings added later.

## Roadmap

See the README's Plan.
