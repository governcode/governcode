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
> Claude Code or Codex Controller to a Codex, Antigravity, Grok or local-model Runner work end to end.
> Expect rough edges.

**Install the release candidate (Linux x86_64):** download
`governcode-0.1.0-motion.8-linux-x86_64.tar.gz` and `SHA256SUMS` from the
[releases page](https://github.com/governcode/governcode/releases), then:

```sh
sha256sum -c SHA256SUMS
tar xzf governcode-0.1.0-motion.8-linux-x86_64.tar.gz
cd governcode-0.1.0-motion.8-linux-x86_64 && ./install.sh   # everything under ~/.local, no root
govd &
gov connect claude   # sign Claude Code in for GovernCode (once); gov connect codex too, for the demo's Runner steps
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

You need Linux with Landlock ABI 6+ (kernel 6.12 or newer), Node 22.18+, Rust, git, `script`
(util-linux) and Claude Code installed (Codex too, to see delegation). Every AI coding tool
GovernCode starts runs in the sandbox, always; there is no switch to turn it off. (A local model
is different: GovernCode sends it text through Ollama's own server and gives it no tools.)

```sh
git clone https://github.com/governcode/governcode && cd governcode
npm ci && cargo build --release
./target/release/govern-sup selftest        # must pass, or govd starts nothing
node packages/gov/src/main.ts daemon start  # or: daemon install (systemd --user)

alias gov="node $PWD/packages/gov/src/main.ts"
gov connect claude # sign Claude Code in for GovernCode (and gov connect codex, to see delegation)
gov demo           # the quickest look: a sample project, one Controller turn, one Runner job, review and undo
```

### Connect your tools

Each AI tool signs in for GovernCode once, with its own sign-in, in a home that belongs to
GovernCode: `gov connect claude`, `gov connect codex`, `gov connect agy`, `gov connect grok`, or
Settings › Tools in the Dashboard. Claude Code and Antigravity show a link, and you paste back
the code the page gives you; Codex's page finishes the sign-in by itself (its browser hands it
back on this computer); Grok shows a link and a code to enter on that page, then finishes by
itself. For the Claude Code and Codex sign-ins the sandbox lets the tool listen on one local port
for that hand-back; nothing else an AI tool runs may listen at all.

- Your own setup for these tools (their folders, logins, settings, keyring) is not used, except
  the personal instructions you choose to bring (below). GovernCode never parses the logins it
  keeps; when a tool refreshes its login during a run, govd copies the new file back as it is.
- Only a subscription sign-in counts as connected, never an API key: GovernCode does not switch
  anything onto paid API use.
- Every run of Claude Code, Codex, Antigravity or Grok starts from a fresh home of its own, with
  only the login linked in (and, for Antigravity, its helper programs, read-only), and that home is
  deleted afterwards: nothing a run writes (memory, knowledge, caches, settings, rules, skills)
  reaches another run, in this project or any other.
- `gov disconnect TOOL` deletes GovernCode's copy of a login. Revoking the tool's access in your
  account ends every sign-in of that tool, your own included.

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

**Project memory.** GovernCode, not the AI tool, keeps what a Controller knows about a project,
so you can switch Controllers without losing the story. Each turn the Controller gets:
- the project's **notes**: a short brief (goal, decisions, open questions, next steps) that the
  Controller keeps current with GovernCode's `project_notes` tool. You read and edit them with
  `gov notes` (`edit`, `history`, `restore`) or the Dashboard's Notes view; every version is
  kept, and they stay in GovernCode, never in your repository;
- the project's **record**, built from the Trace with no AI: recent Specs, Checkpoints and what
  you have allowed for the project;
- the **recent conversation**: the last 10 exchanges, up to about 12,000 characters (long
  messages shortened), until you start a new one (`gov reset`, or **New conversation** in the Dashboard).

All of it goes into the message as information, never as instructions. When you switch a
project to a Controller from another provider (`gov controller codex`, or Change in the
Dashboard), GovernCode shows what it would share and asks once: share, and the new Controller
picks up where the last one left off; or start fresh, and it sees only its own turns. What
carries over is what was said, decided and done, not a tool's private working state. The first time a Controller works, GovernCode asks
whether it should bring **your own instructions** (for Claude Code: your CLAUDE.md, skills,
agents, commands, plugins and hooks, linked into the run's home read-only, plus a few behaviour
settings copied from your settings.json (hooks, plugins, output style, permissions), never its
`env` section or credential helpers; for Codex: your AGENTS.md). Off by
default: it starts clean, with no settings file at all. Change it any time with
`gov personal claude on|off` or in Settings.

Outside a project, `gov ask` runs in Home: the Controller can read and plan but cannot
write any of your files (only its own scratch folders). It can propose a new project (name, folder, git); you get Create or Cancel,
and only your Create makes the folder.

### Delegation (phase 1)

With Codex installed and connected (`gov connect codex`), the Controller can hand a job to it as a
Runner:

```sh
gov ask "Use the governcode delegate tool to have codex write tests for src/tide.rs,
         scope write [\"tests\"], budget 10%, model gpt-5.5, effort medium"
gov specs            # the Spec: Runner, model, status, files
gov diff S-0001      # exactly what the Runner changed
gov accept S-0001    # apply it to your project (or: gov discard S-0001)
gov limits           # each Runner's measured usage against its Limit
gov reserve codex weekly 15   # keep 15% of Codex's weekly window back (default 10)
gov budget codex daily 20 turns   # also: at most 20 Runner turns a day, counted by GovernCode
gov runner codex --model gpt-5.5 --effort medium   # the Runner's defaults
gov spec-models within        # Controller keeps to them: free | within | defaults
```

GovernCode checks Codex's measured usage against your Limit first, runs it in a workspace
of its own inside the sandbox (it can write only the scope), shows every step that needs
approval as a Gate, and applies nothing until you accept. The workspace starts from your project
as it is, uncommitted changes and Specs you accepted included, so you need not commit between
Specs; new files that look like secrets (`.env`, keys) and files git ignores stay out of it.

A **budget** is optional, for any cloud Runner: a cap per window (`5-hour`, `daily`, `weekly`,
`monthly`) in tokens where the Runner reports them, turns otherwise. It is counted by GovernCode
only: GovernCode sees what its own Runners use, not your own sessions or other apps, so set it
below your real plan. When the provider reports its own usage too, the stricter of the two holds.
`gov budget` lists budgets; `gov budget codex daily off` removes one.

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
models, or `gov local 2 15`). If Ollama is not running, the Spec is held; if it refuses the job (busy, model
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

### Grok (xAI) as a Runner

With the [Grok CLI](https://www.npmjs.com/package/@xai-official/grok) (`grok`, a SuperGrok or
similar subscription) installed, connect it once:

```sh
gov connect grok    # or Settings › Tools › Connect in the Dashboard
```

GovernCode runs Grok's own device-code sign-in inside the sandbox, in a home that belongs to
GovernCode (Grok's `GROK_HOME`): open the link it shows, enter the code it prints, sign in, and
it finishes by itself. Your own Grok setup (`~/.grok`: its settings, hooks, plugins and login) is
never used, and GovernCode never reads the login Grok keeps in its home. Only a subscription
sign-in counts, never an API key. `gov disconnect grok` removes it.

Then `grok` is a Runner like `codex`, driven over the Agent Client Protocol (ACP). Every run gets
a fresh home with a config GovernCode writes: every call asks GovernCode first, reads, searches and
directory listings included (Grok's `ask` mode with an `ask` rule for every tool, which outranks
any `allow` rule a project could carry), and no hooks, no plugins, no subagents, no background
workflows, no memory, no Claude, Cursor or Codex compatibility, no updater, no `.envrc`, folder
trust on. In that home the run may write only where Grok keeps its sessions, logs and a few startup
files: its config and its login are read-only to it. A run has two hours; then it is ended.
GovernCode judges each request Grok makes: reading a file, searching and listing a folder are quiet
reads, like a plain `cat` or `ls` (the sandbox bounds what they can read; one that reaches `/dev`,
`/proc` and the like always asks, as `cat` would); commands get the same checks as any other
command; file changes show the request as Grok sent it; and any other call is a step named after
Grok's own tool, or after its kind when Grok gives no name (a catch-all call with no name always
asks). GovernCode answers
"allow once" or rejects; it never picks "allow always", so every call asks again. Its Limit comes
from Grok's own usage report (the credits used this period, the same figure Grok's `/usage`
shows, and when the period ends), so Grok is a measured Runner like Codex; each run's token use
is counted as well. A Spec's Runner runs Grok's default model, or the Grok model the Controller
names, with the reasoning effort it asks for.

Honest limits, for now:
- The Runner can read its own login inside the sandbox (as the Codex Runner can read Codex's),
  and the sandbox limits where it can write, not which HTTPS sites it can reach.
- A project that contains settings Grok would read (`.grok/`, `.agents/` (its skill and command
  folder, which other tools use too), `.claude/settings.json` or `settings.local.json`,
  `.mcp.json`, `.cursor/hooks.json`, `AGENTS.md`, `CLAUDE.md` and their variants, anywhere in the
  copy) is refused: they could switch its asking off or add instructions. A Runner that creates
  one fails its Spec.
- Subagents and background workflows are off for every Grok run (a Runner has no use for them),
  so the Crew card's "Runners may start subagents" does not apply to Grok. Skills have no switch,
  but a fresh home holds none, so Grok has no skill tool. Its task list and its background-task
  tools stay, and ask like every other call (seen live, though Grok's own guide lists them as
  never prompting).
- A project copy with a link to a folder, out of the copy, or to nothing is refused too: the
  settings check does not follow links, so a link could hide an instruction file from it.
- Grok keeps remembered approvals under its `sessions/` folder, which a run must be able to
  write. GovernCode never grants one (the "always allow" choices are switched off and never
  chosen), but a command you allowed could write such a file itself for the rest of that run;
  the run's home is fresh and deleted afterwards, and the sandbox still bounds what any call
  can do to the Spec's scope.
- Because the login is read-only inside a run, Grok cannot refresh its token there; when it
  expires, Grok shows as needing attention and `gov connect grok` signs it in again.
- Its Limit is Grok's own figure: an account that has used nothing this period reports none
  yet, and GovernCode holds Grok until it does (use Grok once outside GovernCode).
- Grok's own questions to the user, and its requests to read or write files through the client,
  are refused (GovernCode offers neither), so a job that needs them stops there.
- The asking itself is Grok's: it brings each call to GovernCode as its permission request. The
  sandbox holds whatever it does to the Spec's scope; the Gate is your review of each call Grok
  brings, not a second sandbox.

Gemini CLI (for Gemini API keys) comes later, once GovernCode can hold a key safely.

### Crew and delegation

Each project has a **Crew card** (`gov crew`, or the Dashboard's Crew view). You set it; GovernCode
enforces it, and the Controller is told it each turn:
- **The Controller** works itself and hands off (default), or plans and hands off only (then the
  project is read-only for it in the sandbox).
- **Handing off**: *ask me each time* (default: a handoff to a paid Runner waits at a Gate),
  *follow the approved plan*, or *off* (the Controller works alone).
- **Runners**: which ones this project may use, and the most one job may reserve of each.
- **Subagents**, for the Controller and for Runners: off removes Claude Code's subagent tool,
  switches Codex's multi-agent features off (Grok's are off in every run, whatever the card
  says), and refuses Antigravity's subagent tools. That covers
  each tool's own subagent features; starting another AI program from a command is a step that
  always asks, whatever the card says.

Before bigger work the Controller is asked to post a **game plan** with GovernCode's `plan` tool
(it is not forced to): who does what. You approve it (all or some items), answer "just you" (it does everything itself and
cannot hand off for the rest of the turn), or reject it. govd decides every handoff itself,
however the Controller reaches it. With *follow the approved plan*, each approved item lets one
handoff to that Runner through without asking again (the Runner is matched, not the item's
wording; the handoff is on the record with exactly what it handed over); the Runner's own steps
still stop at their Gates. Only a Controller hands work to other tools: Runners get no
delegate tool.

### The Dashboard (desktop app, early)

```sh
npm run build -w apps/dashboard
npm start -w apps/dashboard
```

It talks to the same `govd`: chat with the Controller and answer Gates inline, review
Specs (diff side by side, accept, discard), undo Checkpoints, see and set each Runner's
Limits, connect tools (Settings › Tools), set each project's Crew card and edit its Notes,
change each project's Controller, Gates across projects and the Trace. The window's page has no direct access to your files or sockets: it can only ask
the app's main process, which passes a fixed list of requests to `govd`.

### A govd on another machine (SSH)

```sh
gov tunnel build-box              # keeps running; Ctrl-C closes it
gov --host build-box status       # from another terminal: any gov command, run against build-box
gov tunnel                        # the tunnels open now; gov tunnel --stop build-box closes one
```

`gov tunnel HOST` asks HOST where its `govd` listens (`gov socket-path` there, else the default
path; `--remote-socket PATH` to say it yourself), then has `ssh` forward that Unix socket to
`$XDG_RUNTIME_DIR/governcode-tunnels/HOST/govd.sock`, in a folder only you can enter. It checks
that `govd` answers before it says the tunnel is up, and removes the socket when it closes.
Login is key-based only (`BatchMode`: it never asks for a password), so check
`ssh -o BatchMode=yes HOST true` first. Nothing new is trusted: the SSH user is the `govd` user
there. For the Dashboard, start it with the `GOVERNCODE_RUNTIME_DIR` the tunnel prints.

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
