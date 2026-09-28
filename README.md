<p align="center"><img src="docs/brand/governcode-icon.svg" width="112" alt="GovernCode logo"></p>

# GovernCode

**Govern your AI coding crew.** Pick one AI coding tool as the Controller. It keeps its own
subagents and hands bounded jobs (Specs) to the other tools you already use, as Runners.
Every Spec is written down and works on its own copy of the project (a coding tool runs in a
sandbox; a local model's files are checked against the Spec's scope), and nothing reaches your
project until you have seen the diff and accepted it. A Controller's own turns can be undone.
A Limit holds a Spec back before it would reach into the reserve you set for that provider
(usage reports lag, so a running Spec can overshoot a little), and risky steps wait at a Gate for your approval, in the Dashboard or your terminal (on your phone once
the Pager app ships, phase 3).

Free and open source (MIT). Runs on your own machine; no hosted service.

## What we stand for

1. **You hold the controls.** 2. **You ship it, you own it.** 3. **Deny by default, fail closed.**
4. **Any model can lead.** 5. **Honest about limits.** 6. **Free and open, forever.**
7. **Built with AI, openly.** 8. **Small, boring, verifiable.** 9. **Respect, always.** What each one means:
[docs/PHILOSOPHY.md](docs/PHILOSOPHY.md).

## Release channels

One repository, three channels: **Debate** (the `debate` branch, where work and new ideas
happen), **Motion** (release candidates, tagged `vX.Y.Z-motion.N`) and **Decree** (stable
releases, tagged `vX.Y.Z`). The first Motion is
[0.1.0-motion.1](https://github.com/governcode/governcode/releases/tag/v0.1.0-motion.1).

> **Status: pre-alpha, release candidate.** Developers can try it on Linux, from the
> CLI or the early Dashboard: the sandbox, Gates, Checkpoints, Limits, and delegation from a
> Claude Code or Codex Controller to a Codex, Antigravity or local-model Runner work end to end.
> Expect rough edges.

**Install the release candidate (Linux x86_64):** download
`governcode-0.1.0-motion.6-linux-x86_64.tar.gz` and `SHA256SUMS` from the
[releases page](https://github.com/governcode/governcode/releases), then:

```sh
sha256sum -c SHA256SUMS
tar xzf governcode-0.1.0-motion.6-linux-x86_64.tar.gz
cd governcode-0.1.0-motion.6-linux-x86_64 && ./install.sh   # everything under ~/.local, no root
govd &
gov demo
```

To remove it: `./install.sh --uninstall` takes out the service, the commands, the launcher entry
and every release it installed, and keeps your settings and Trace; add `--purge` to remove those
too. It removes only what it can show is GovernCode's (releases installed before motion.6 carry
no mark: it lists them for you to remove) and does not touch your project folders.

For a longer tour, [examples/tidepool](examples/tidepool) is a small project with a real bug and
a missing feature, and [DEMO.md](examples/tidepool/DEMO.md) walks through every part of
GovernCode with it in about fifteen minutes.

## Try it (developers, Linux)

You need Linux with Landlock ABI 6+ (kernel 6.12 or newer), Node 22.18+, Rust, git, and
Claude Code installed and logged in (Codex too, to see delegation). Every AI coding tool
GovernCode starts runs in the sandbox, always; there is no switch to turn it off. (A local model
is different: GovernCode sends it text through Ollama's own server and gives it no tools.)

```sh
git clone https://github.com/governcode/governcode && cd governcode
npm ci && cargo build --release
./target/release/govern-sup selftest        # must pass, or govd starts nothing
node packages/gov/src/main.ts daemon start  # or: daemon install (systemd --user)

alias gov="node $PWD/packages/gov/src/main.ts"
gov demo           # the quickest look: a sample project, one Controller turn, one Runner job, review and undo
```

Or on your own project:

```sh
gov new demo --path ~/code/demo && cd ~/code/demo
gov controller claude-code --model sonnet --effort medium
gov ask "Add a README with one line about this project"
gov gates          # from another terminal: what is waiting, exactly as it will run
gov allows         # the standing allows you remembered for projects (revocable)
gov trace          # what happened (gov trace --jsonl to export it)
gov turns          # Checkpoints of the Controller's turns that changed files
gov undo T-12      # put those files back, if you have not changed them since
```

How often Gates ask is your choice: **Relaxed**, **Balanced** (the default) or **Strict**
(`gov level`, or Settings in the Dashboard). At a Gate you can allow one step, or **allow that
kind of step for the rest of this turn** (a Runner: this Spec) **or this project**, so you are
not asked about every `npm test`; a command like `cd app && npm test | tail` counts as
`npm test`. That only skips the question: the sandbox applies to every step at every level,
risky steps always ask (deleting, git commands that change the repository, installing packages,
network tools, interpreters, handing work to a paid Runner), and everything is in the Trace. Details:
[docs/SANDBOX.md](docs/SANDBOX.md#gates-and-standing-allows-fewer-questions-the-same-sandbox).

The Controller remembers the project's recent conversation (the last 10 exchanges, up to about
12,000 characters) until you start a new one (`gov reset`, or **New conversation** in the
Dashboard). The first time a Controller works, GovernCode asks
whether it should bring **your own instructions** (for Claude Code: your CLAUDE.md, skills,
agents and hooks; for Codex: your AGENTS.md). Off by default: it starts clean. Change it any time
with `gov personal claude on|off` or in Settings.

Outside a project, `gov ask` runs in Home: the Controller can read and plan but cannot
write any of your files (only its own scratch folders). It can propose a new project (name, folder, git); you get Create or Cancel,
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

**Local models.** With [Ollama](https://ollama.com) running and a model pulled, `ollama` is a
Runner too: good for small, well-scoped jobs (docs, comments, small fixes) that cost no quota.

```sh
ollama pull qwen3.5:9b
gov ask "Use the governcode delegate tool to have ollama (model qwen3.5:9b) add a Usage
         section to README.md, scope read [\"src\"], write [\"README.md\"]"
```

A local model gets no tools and runs no commands. It sees the files in the Spec's scope and
proposes whole new files; GovernCode itself checks each path against the write scope (nothing
outside it, nothing in `.git`, never through a symlink) before writing it into the Spec's
workspace, and you review it like any other Spec. There is no quota to measure, so its Limit is
your machine's: at most 1 local Spec at once, each stopped after 10 minutes (Settings › Local
models). If Ollama is not running, the Spec is held; if it refuses the job (busy, model
missing), the Spec fails with Ollama's own words.

### Antigravity (Google) as a Runner

With the [Antigravity CLI](https://antigravity.google) (`agy`) installed, connect it once:

```sh
gov connect agy     # or Settings › Tools › Connect in the Dashboard
```

GovernCode runs Antigravity's own sign-in (under a terminal from `script`, part of util-linux)
inside the sandbox, in a home that belongs to
GovernCode: open the link it shows, sign in with Google, paste the code back (Antigravity waits
about a minute). Your own Antigravity setup, keyring and settings are not used, and GovernCode
never reads the login Antigravity keeps there. `gov disconnect agy` removes it.

Then `agy` is a Runner like `codex`. Every tool call Antigravity makes passes GovernCode's Gate
(through Antigravity's own pre-tool hook): plain reads run, commands get the same checks as any
other command, file changes show exactly what will be written (for an edit, the text replaced and
its replacement), and any other tool is a kind of step like any other: it asks at Balanced and
Strict until you allow it for a Spec or the project, and runs at Relaxed. Its Limit comes from
Antigravity's own usage report (weekly and 5-hour windows).

Honest limits, for now:
- It runs **Gemini models only** (or Antigravity's default): its Limit reads Antigravity's Gemini
  pool, and Claude or GPT models through Antigravity draw on another pool it does not watch yet.
- The Runner can read its own login inside the sandbox (as the Codex Runner can read Codex's),
  and the sandbox limits where it can write, not which HTTPS sites it can reach.
- `gov disconnect agy` deletes GovernCode's copy of the login. Revoking Antigravity's access in
  your Google account ends every Antigravity sign-in, your own included.
- A project that contains Antigravity customization folders (`.agents/`, `.agent/`, `_agents/`,
  `_agent/`) is refused: their hooks could switch GovernCode's Gate off. A Runner that creates one
  fails its Spec.

Claude Code and Codex still use your own logins; they move to the same Connect step in a later
release. Gemini CLI (for Gemini API keys) comes after that, once GovernCode can hold a key safely.

### The Dashboard (desktop app, early)

```sh
npm run build -w apps/dashboard
npm start -w apps/dashboard
```

It talks to the same `govd`: chat with the Controller and answer Gates inline, review
Specs (diff side by side, accept, discard), undo Checkpoints, see and set each Runner's
Limits, connect tools (Settings › Tools), change each project's Controller, Gates across projects
and the Trace. The window's page has no direct access to your files or sockets: it can only ask
the app's main process, which passes a fixed list of requests to `govd`.

## Plan

| Phase | Delivers |
|---|---|
| 0 | `govd` + `govern-sup` + `gov`: deny-by-default sandbox and its self-test; Claude Code driver; the Trace (event log) |
| 1 | Controller + `delegate`; Codex as the first measured Runner; Limits with in-flight checks; Checkpoints + undo |
| 2 | Dashboard desktop app; review queue; Gates |
| 3 | Pager phone app (Android first); pairing; phone-signed Gates; remote from laptops |
| 4 | Modules (plugins) and their Registry |
| 5 | iOS; driver Modules; launch |

**Platforms.** Linux first, while the core is built. Then macOS and Windows together, with the
same priority: neither waits for the other, and a release that adds one adds both. GovernCode
should work for as many people as want it, and three platforms find more bugs than one.

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
- **Codex (OpenAI)**: code and security reviews (the sandbox, the git guard, the Gate rules)
  and test runs.
- **Grok (xAI)**: research on the landscape and red-team security reviews.
- **Gemini (Google)**: naming and design work, including the phone mockups.

Contributors: OneLegDave and Claude. Credit is recorded here rather than in commit
messages. Some designs are adapted from [T3 Code](https://github.com/pingdotgg/t3code)
(MIT); where code is adapted, its notice is kept.

## License

MIT. See [LICENSE](LICENSE). Free, and it always will be: no paid tier, no catch.

*Oh, by the way:* if GovernCode saves you an afternoon and you feel like saying thanks, you can
[buy Dave a coffee](https://buymeacoffee.com/onelegdave). The crew runs on tokens; Dave runs
on coffee. Only one of them has a button. Zero pressure: the code is yours either way.
