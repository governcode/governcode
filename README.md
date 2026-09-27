<p align="center"><img src="docs/brand/governcode-icon.svg" width="112" alt="GovernCode logo"></p>

# GovernCode

**Govern your AI coding crew.** Pick one AI coding tool as the Controller. It keeps its own
subagents and hands bounded jobs (Specs) to the other tools you already use, as Runners.
Every Spec is written down, runs in a sandbox and its own git worktree, and can be diffed
and undone. A Limit keeps each provider's usage above the reserve you set, and risky steps
wait at a Gate for your approval, signed on your phone.

Free and open source (MIT). Runs on your own machine; no hosted service.

> **Status: pre-alpha, phases 1 and 2.** Developers can try it on Linux, from the CLI or
> the early Dashboard: the sandbox, Gates, Checkpoints, Limits, and delegation from a Claude
> Code or Codex Controller to a Codex Runner work end to end. Expect rough edges; nothing is
> released yet.

## Try it (developers, Linux)

Phase 0 runs one Controller (Claude Code) in the sandbox and asks you at every Gate. You
need Linux with Landlock ABI 6+ (kernel 6.12 or newer), Node 22.18+, Rust, git, and
Claude Code installed and logged in.

```sh
git clone https://github.com/onelegdave/governcode && cd governcode
npm ci && cargo build --release
./target/release/govern-sup selftest        # must pass, or govd starts nothing
node packages/gov/src/main.ts daemon start  # or: daemon install (systemd --user)

alias gov="node $PWD/packages/gov/src/main.ts"
gov new demo --path ~/code/demo && cd ~/code/demo
gov controller claude-code --model sonnet --effort medium
gov ask "Add a README with one line about this project"
gov gates          # from another terminal: what is waiting, exactly as it will run
gov trace          # what happened (gov trace --jsonl to export it)
gov turns          # Checkpoints of the Controller's turns that changed files
gov undo T-12      # put those files back, if you have not changed them since
```

Outside a project, `gov ask` runs in Home: the Controller can read and plan but cannot
write anything. It can propose a new project (name, folder, git); you get Create or Cancel,
and only your Create makes the folder.

### Delegation (phase 1)

With Codex installed and logged in, the Controller can hand a job to it as a Runner:

```sh
gov ask "Use the governcode delegate tool to have codex write tests for src/tide.rs,
         scope write [\"tests\"], budget 10%, model gpt-5.5, effort medium"
gov specs            # the Spec: Runner, model, status, files
gov diff S-0001      # exactly what the Runner changed
gov accept S-0001    # apply it to your project (or: gov discard S-0001)
gov limits           # each Runner's measured usage against its Limit
gov reserve codex weekly 15   # keep 15% of Codex's weekly window back (default 10)
gov runner codex --model gpt-5.5 --effort medium   # the Runner's defaults
gov spec-models within        # Controller keeps to them: free | within | defaults
```

GovernCode checks Codex's measured usage against your Limit first, runs it in a workspace
of its own inside the sandbox (it can write only the scope), shows every step that needs
approval as a Gate, and applies nothing until you accept.

### The Dashboard (desktop app, early)

```sh
npm run build -w apps/dashboard
npm start -w apps/dashboard
```

It talks to the same `govd`: chat with the Controller and answer Gates inline, review
Specs (diff side by side, accept, discard), undo Checkpoints, see and set each Runner's
Limits, change each project's Controller, Gates across projects and the Trace. The window's page
has no access to your files or sockets; only the app's main process talks to `govd`.

## Plan

| Phase | Delivers |
|---|---|
| 0 | `govd` + `govern-sup` + `gov`: deny-by-default sandbox and its self-test; Claude Code driver; the Trace (event log) |
| 1 | Controller + `delegate`; Codex as the first measured Runner; Limits with in-flight checks; Checkpoints + undo |
| 2 | Dashboard desktop app (Linux, macOS); review queue; Gates |
| 3 | Pager phone app (Android first); pairing; phone-signed Gates; remote from laptops |
| 4 | Modules (plugins) and their Registry |
| 5 | iOS; driver Modules; launch |

Linux and macOS are first-class. Windows is not supported yet.

## Vocabulary

| Term | Meaning |
|---|---|
| Controller | The AI tool you appoint to lead a project |
| Runners | The other AI tools the Controller can delegate to |
| Spec | One delegated job: brief, acceptance, scope, budget, workspace, model and effort |
| Limit | The usage reserve a provider must keep; unknown usage means held |
| Gate | An approval request |
| Checkpoint | A git snapshot before and after a Spec, for diff and undo |
| Trace | The append-only history |
| Dashboard / Pager | The desktop app / the phone app |
| Modules / Registry | Plugins / where they are published |

## How this is built: AI-assisted, openly

GovernCode is developed with heavy AI assistance, and we say exactly how:

- **OneLegDave** ([onelegdave.dev](https://www.onelegdave.dev/) · [X](https://x.com/OneLegDavePDX) ·
  [GitHub](https://github.com/onelegdave)): owner and maintainer. A human holds the controls:
  he makes every product decision and reviews what ships.
- **Claude (Anthropic)**: lead AI developer: architecture, most of the code, reviews,
  and integration.
- **Grok (xAI)**: research on the landscape and red-team security reviews.
- **Gemini (Google)**: naming and design work, including the phone mockups.

Contributors: OneLegDave and Claude. Credit is recorded here rather than in commit
messages. Some designs are adapted from [T3 Code](https://github.com/pingdotgg/t3code)
(MIT); where code is adapted, its notice is kept.

## License

MIT. See [LICENSE](LICENSE).
