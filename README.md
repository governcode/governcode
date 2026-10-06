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
> Claude Code or Codex Controller to a Codex, Antigravity, Grok, OpenCode or local-model Runner work end to end.
> Expect rough edges.

**Install the release candidate (Linux x86_64):** download
`governcode-0.1.0-motion.10-linux-x86_64.tar.gz` and `SHA256SUMS` from the
[releases page](https://github.com/governcode/governcode/releases), then:

```sh
sha256sum -c SHA256SUMS
tar xzf governcode-0.1.0-motion.10-linux-x86_64.tar.gz
cd governcode-0.1.0-motion.10-linux-x86_64 && ./install.sh --service   # everything under ~/.local, no root; govd starts at login
gov connect claude   # sign Claude Code in for GovernCode (once); gov connect codex too, for the demo's Runner steps
gov demo
governcode-dashboard # the desktop app (also "GovernCode Dashboard" in your app launcher)
```

Without `--service`, start govd yourself when you want it: `govd &`, or `gov daemon start`.

To remove it: `./install.sh --uninstall` takes out the service, the commands, the launcher entry
and every release it installed, and keeps your settings and Trace; add `--purge` to remove those
too. It removes only what it can show is GovernCode's (releases installed before motion.6 carry
no mark: it lists them for you to remove) and does not touch your project folders.

For a longer tour, [examples/tidepool](examples/tidepool) is a small project with a real bug and
a missing feature, and [DEMO.md](examples/tidepool/DEMO.md) walks through every part of
GovernCode with it in about fifteen minutes.

## Try it (developers, Linux)

You need Linux with Landlock ABI 6+ (kernel 6.12 or newer), Node 22.18+, Rust, git, `script`
(util-linux) and Claude Code installed (Codex too, to see delegation).
Controller delegation needs Landlock ABI 9 for its restricted Unix socket; ABI 6–8 block
all new Unix sockets. Every AI coding tool
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
GovernCode: `gov connect claude`, `gov connect codex`, `gov connect agy`, `gov connect grok`,
`gov connect opencode`, or Settings › Tools in the Dashboard. Claude Code and Antigravity show a link, and you paste back
the code the page gives you; Codex's page finishes the sign-in by itself (its browser hands it
back on this computer); Grok shows a link and a code to enter on that page, then finishes by
itself; OpenCode takes the API key you paste from its page. For the Claude Code and Codex sign-ins
the sandbox lets the tool listen on one local port for that hand-back, and an OpenCode Runner's
server listens on one port that nothing in its sandbox may connect to (below); nothing else an AI
tool runs may listen at all.

- Your own setup for these tools (their folders, logins, settings, keyring) is not used, except
  the personal instructions you choose to bring (below). GovernCode never parses the logins it
  keeps; when a tool refreshes its login during a run, govd copies the new file back as it is.
- Only a subscription sign-in counts as connected, never an API key: GovernCode does not switch
  anything onto paid API use. OpenCode is the one exception, because its subscription (OpenCode
  Go) signs in with a key: GovernCode keeps that key for OpenCode Go alone and refuses OpenCode's
  pay-as-you-go Zen models.
- Every run of Claude Code, Codex, Antigravity or Grok starts from a fresh home of its own, with
  only the login linked in (and, for Antigravity, its helper programs, read-only), and that home is
  deleted afterwards: nothing a run writes (memory, knowledge, caches, settings, rules, skills)
  reaches another run, in this project or any other.
- `gov disconnect TOOL` deletes GovernCode's copy of a login. Revoking the tool's access in your
  account ends every sign-in of that tool, your own included.

Or on your own project:

```sh
gov new demo --path ~/code/demo && cd ~/code/demo   # or, for a folder you already have: gov open PATH [NAME]
gov controller claude-code --model sonnet --effort medium
gov ask "Add a README with one line about this project"
gov gates          # from another terminal: what is waiting, exactly as it will run
gov gate G-3 allow # answer it there: allow|deny, and --turn, --spec or --project to remember it
gov allows         # the standing allows you remembered for projects (revocable)
gov trace          # what happened (gov trace --jsonl to export it)
gov friction       # the last 7 days' Gates, failed turns and refusals, read from the Trace (changes nothing)
gov turns          # Checkpoints of the Controller's turns that changed files
gov undo T-12      # put those files back, if you have not changed them since
gov status         # govd's version and sandbox; gov projects and gov settings list the rest
```

A Gate waits for your answer: in `gov ask`, from another terminal, or in the Dashboard. In
`gov ask` a line counts only for the question on screen: one typed (or piped) before it was shown,
or in its first second, is ignored, so an answer never lands on a question you did not see. With
stdin closed (e.g. `< /dev/null`), `gov ask` answers nothing itself; it says where to answer and
keeps waiting: `gov gate G-N allow|deny [--turn|--spec|--project]` for a Gate,
`gov plan GP-N approve [1,3]|just-you|reject` for a game plan, and
`gov proposal P-N create|cancel` for a proposed project. A question answered elsewhere leaves
`gov ask` with a line saying so.

How often Gates ask is your choice: **Relaxed**, **Balanced** (the default) or **Strict**
(`gov level`, or Settings in the Dashboard). At a Gate you can allow one step, or **allow that
kind of step for the rest of this turn** (a Runner: this Spec) **or this project**, so you are
not asked about every `npm test`; a command like `cd app && npm test | tail` counts as
`npm test`. That only skips the question: the sandbox applies to every step at every level,
risky steps always ask (deleting, git commands that change the repository, installing packages,
network tools, interpreters, handing work to a paid Runner), and everything is in the Trace.
`gov friction [--project NAME] [--days N] [--json]` counts from it how often you were asked, who
answered, and which kinds of step (`npm test`, file edits) you allowed every time: candidates for a
standing allow, and which kinds of step probably ran into the sandbox (a step that failed saying
what the sandbox says when it refuses something: an estimate, and only the kind is recorded, never
the output). It only reads, and makes no rule. Details:
[docs/SANDBOX.md](docs/SANDBOX.md#gates-and-standing-allows-fewer-questions-the-same-sandbox).

**Project memory.** GovernCode, not the AI tool, keeps what a Controller knows about a project,
so you can switch Controllers without losing the story. Each turn the Controller gets:
- the project's **notes**: a short brief (goal, decisions, open questions, next steps) that the
  Controller keeps current with GovernCode's `project_notes` tool. You read and edit them with
  `gov notes` (`edit`, `history`, `restore`) or a project's Notes in the Dashboard; every version is
  kept, and they stay in GovernCode, never in your repository;
- the project's **record**, built from the Trace with no AI: recent Specs, Checkpoints and what
  you have allowed for the project;
- the **recent conversation**, until you start a new one (`gov reset`, or **New conversation** in
  the Dashboard): whole messages only, never cut, within about 16,000 characters (`gov memory`, or
  Settings › Project memory). Your
  latest message, the latest reply and your first message go first, then the rest newest to oldest;
  each reply says which Controller wrote it. Whatever does not fit is left out whole, and the
  Controller can read it with GovernCode's `conversation_read` tool (never before a reset).

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
gov accept S-0001    # show the current diff, then confirm applying it (or: gov discard S-0001)
gov cancel S-0002    # stop a Spec that is still running (what it changed stays for review)
gov limits           # each Runner's measured usage against its Limit
gov reserve codex weekly 15   # keep 15% of Codex's weekly window back (default 10)
gov budget codex daily 20 turns   # also: at most 20 Runner turns a day, counted by GovernCode
gov runner codex --model gpt-5.5 --effort medium   # the Runner's defaults
gov spec-models within        # Controller keeps to them: free | within | defaults
gov spec-caps 3 2             # at most 3 Specs at once in a project, 2 for one Runner (the default)
```

GovernCode checks Codex's measured usage against your Limit first, runs it in a workspace
of its own inside the sandbox (it can write only the scope), shows every step that needs
approval as a Gate, and applies nothing until you accept. The workspace starts from your project
as it is: your uncommitted edits, and the files of Specs you accepted, are in it, so you need not
commit between Specs. Other new files you have not committed come in only if the Spec's scope
names them (the Spec says which stayed out); files git ignores, and new files that look like
secrets (`.env`, keys) or hold a private key, never do.

Accept is bound to the snapshots shown in the diff. If a follow-up or recovery round changes
them before confirmation, nothing is applied: review the new diff first. The Dashboard enables
Accept only after that diff loads. `gov accept` shows the diff and asks before applying it;
scripts must name snapshots already reviewed with `--before OID --after OID` (the full ids from
`gov diff`). Older clients that omit the snapshots cannot accept work.

A Spec runs on its own: the Controller's turn can end while it works, and several can run side by
side, each in its own copy (up to the caps above; the Limit counts them all together). A Runner's
Gates belong to its Spec, not to the turn or the terminal that started it: they wait in every
client (`gov gates`, the Dashboard) for up to an hour, and are denied if nobody answers or the
Spec ends. The Controller can ask for the result in the same call instead (it then waits up to
ten minutes by default), stop a Spec (`spec_cancel`; what it changed so far stays for your review),
or send its Runner back to it with a follow-up (`spec_followup`: the same copy and scope, a new
Gate and Limit check; the diff and your Accept then cover every round). When a Spec finishes, the
Controller hears of it as the Crew card says (below). If govd stops while Specs run, they are
marked failed when it starts again, with their copy kept for review (`gov diff`), and your next
message tells the Controller; nothing starts by itself after a restart.

**Usage limits.** When a Limit holds a Spec, or a Runner or Controller runs out of usage,
GovernCode records it with the reset time the provider gave. `gov limited` (or the Dashboard)
shows each one; `gov resume ID` resumes now, `gov resume ID --at-reset` opts it in at reset, and
`--clear` clears its recovery record. Resume at reset is off by default (`gov auto-resume on`
makes it the default), and unattended resumes run only while the Dashboard is open. A resume
measures usage and checks the Limit again; a held Spec gets a fresh copy of the project.
GovernCode never guesses a reset time: Grok gives none, so resume it yourself.

An honest limit that applies to every Runner: a Runner can read its own login (the sign-in it
works with, in its run's home) inside the sandbox, and reading is a quiet step, so no Gate asks
first. Like any text, a Runner could repeat it in its words or write it into its changes, where
you would see it in the diff. Keeping the login out of the Runner's own reach is planned together
with GovernCode's secrets storage.

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
- The Runner can read its own login inside the sandbox, as every Runner can (see Delegation), and
  the sandbox limits where it can write, not which HTTPS sites it can reach.
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
- The Runner can read its own login inside the sandbox, as every Runner can (see Delegation), and
  the sandbox limits where it can write, not which HTTPS sites it can reach.
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

### OpenCode as a Runner

With [OpenCode](https://opencode.ai) 2.0 (`opencode`) and an OpenCode Go subscription, OpenCode can
take Specs (`gov connect opencode`, or Settings › Tools). Connect asks for the API key from
opencode.ai/auth and gives it to OpenCode's own credential store in a home that belongs to
GovernCode, for OpenCode Go only; your own OpenCode setup (`~/.local/share/opencode`, its config,
plugins and background service) is never used. A Runner may use OpenCode Go's models and OpenCode's
free models, never a paid Zen model: GovernCode refuses one by name, checks OpenCode's own model
list before every run, and holds no Zen login for one to use.

OpenCode 2.0 is a client and a server: the server runs the model's tools and answers its own
permission requests to whoever reaches it on its local port, and a command it runs could read its
password. So GovernCode does not use OpenCode's ACP mode. govd starts `opencode serve` in the
sandbox with a rule the kernel enforces: it may listen on its one port and may not connect to it,
and neither may anything it runs; govd, outside the sandbox, is its only client. The sandbox
self-test proves that rule on every start.

- Every permission request is a Gate, answered "once" or "reject", never "always". A command is
  judged like every Runner's; a file change shows its patch; a read is a quiet read. A declined
  Gate tells the model and it goes on without that step. Subagents are refused.
- GovernCode's config comes with each run: every action asks, subagents are off, nothing is shared,
  no updates, no MCP servers; OpenCode's project config is off. Before the prompt, govd checks that
  an edit and a command really ask, and runs nothing if they do not.
- Each run gets a fresh home with a copy of Connect's OpenCode database (where OpenCode keeps the
  key) and nothing is copied back, so nothing a run saves reaches another run. A project with
  OpenCode settings or instructions (`.opencode/`, `opencode.json`, `AGENTS.md`, `CLAUDE.md`,
  `CONTEXT.md`, `.agents/`, `.claude/`) is refused, and a Runner that creates one fails its Spec.
- OpenCode reports no usage window GovernCode can read, so set a counted budget for it
  (`gov budget opencode ...`); without one its Runners are held. When OpenCode Go says its usage
  limit is reached, the Spec is held like any limited Spec; no reset time is given, so resume it
  yourself.
- New: tested against a fake built from OpenCode 2.0.23's real events, and run live in the sandbox
  with a free model and with an OpenCode Go model.

Gemini CLI (for Gemini API keys) comes later, once GovernCode can hold a key safely.

### ACP registry and artifact storage (development)

The development checkout can search the official Agent Client Protocol registry and inspect an
agent's advertised distribution and Runner eligibility:

```sh
gov acp search opencode
gov acp inspect opencode --kind binary
gov acp inspect opencode --platform linux-x86_64 --kind binary --json
gov acp search --refresh
```

Inspection shows the exact version, source, SHA-256 or pinned package version, and the catalog's
fetch time and digest. Multiple distributions require an explicit `--kind`; unsupported recipes
explain why they cannot be planned. These commands read metadata only.

The first storage slice accepts SHA-256 verified **raw Linux ELF binaries** for this host's exact
architecture. Inspection also shows a review fingerprint and whether storage is supported:

```sh
gov acp install AGENT_ID --kind binary
gov acp installed --json
gov acp cancel I-N
```

Install refreshes the official catalog and refuses changed metadata. It shows a mandatory Gate
with the exact source, hash, version, platform and advertised command; approval cannot be
remembered. You can answer in an interactive terminal, the Dashboard, or with
`gov gate G-N allow|deny`. Piped input cannot approve installation, even if it arrives after the prompt.
Cancellation, requester disconnection and daemon shutdown stop the operation and clean normal
staging files. Detected replacements or ambiguous state are retained for manual recovery.
Successful bytes and a provenance receipt are stored privately and reverified on reuse.
The version is registry-advertised; no version command runs. Interrupted state is refused for
inspection rather than adopted or resumed. Archives, npm and uv installation are not implemented,
so an archive distribution such as OpenCode's cannot be stored by this slice.

Inspect a stored artifact using its lowercase 64-character installation ID from
`gov acp installed`, rather than its registry agent ID:

```sh
gov acp inspect-installed INSTALLATION_ID
gov acp inspect-installed INSTALLATION_ID --json
```

This read-only command checks the stored receipt and artifact, then inspects a private ELF
snapshot. It reports receipt provenance and either a supported-layout observation with no
interpreter or dynamic segments, or a parser refusal. A parser refusal leaves the verified
installation intact; a store-validation failure returns an error with no observation. JSON
output contains only the receipt and inspection result. This does not establish runtime
compatibility or Runner eligibility, and it executes no artifact.

Artifact storage grants no permission to probe, sign in, execute or spend. Registry membership
never makes an agent a Runner:
that requires an audited profile for its exact version and platform, a verified subscription
connection, and ready usage accounting. OpenCode's current profile is blocked because its ACP
process starts an HTTP listener, which conflicts with the Runner sandbox's no-bind rule.

### Crew and delegation

Each project has a **Crew card** (`gov crew`, or a project's Crew card in the Dashboard). You set it; GovernCode
enforces it, and the Controller is told it each turn:
- **The Controller** works itself and hands off (default), or plans and hands off only (then the
  project is read-only for it in the sandbox).
- **Handing off**: *ask me each time* (default: a handoff to a paid Runner waits at a Gate),
  *follow the approved plan*, or *off* (the Controller works alone).
- **Runners**: which ones this project may use, and the most one job may reserve of each.
- **When a Spec finishes** (`gov crew wake auto|tell|off`): *auto* (default) starts a short
  Controller turn by itself to read the result and tell you, only while the Dashboard is open (it
  uses the Controller's allowance; a message you send meanwhile goes right after it); *tell*
  passes it to the Controller with your next message; *off* does not tell the Controller. The
  Controller gets the Spec's id and state from GovernCode, never the Runner's words as a message:
  it reads those with `spec_status`, as data. Whatever the setting, only you accept a Spec.
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
governcode-dashboard                                           # from a release
npm run build -w apps/dashboard && npm start -w apps/dashboard  # from a checkout
```

It talks to the same `govd`. The sidebar has the **Overview** (what needs you, every project at a
glance, what each AI has left, the sandbox), **Needs you** (Gates, finished Specs and held work
from every project), **Watch** (what your crew is doing right now, live, also in its own window), **Home** (a Controller without a project), **Allowance** (each Runner's usage
windows against the reserve you keep, when each resets, and at the recent pace whether it would
reach the reserve first), the **Trace**, your projects and your crew. Inside a
project: the **Conversation** with its Controller (Gates answered inline), **Specs** (review the
diff side by side, accept, discard), **Checkpoints** to undo, **Notes**, its Trace and its **Crew
card**. Settings has Tools (connect each AI tool), Limits and Gates, and Appearance: light or dark,
following your system unless you choose. The window's page has no direct access to your files or
sockets: it can only ask the app's main process, which passes a fixed list of requests to `govd`.

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
| Checkpoint | A snapshot of files before and after a Controller turn (for undo) or a Spec (for its diff) |
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

## Trademarks

GovernCode is an independent open-source project, not affiliated with, endorsed by, or sponsored
by Anthropic, OpenAI, xAI, Google, Ollama, or the makers of OpenCode. Claude and Claude Code are trademarks of Anthropic,
PBC. OpenAI and Codex are trademarks of OpenAI. Grok is a trademark of xAI. Google Antigravity and
Gemini are trademarks of Google LLC. Ollama is a trademark of Ollama. OpenCode belongs to its owner. Their names and logos are
used only to identify the tools GovernCode works with; the logo files are not covered by
GovernCode's licence (see `apps/dashboard/src/renderer/public/licenses/PROVIDER-MARKS.md`). The
Dashboard's fonts, Inter and JetBrains Mono, are under the SIL Open Font License 1.1.

## License

MIT. See [LICENSE](LICENSE). Free, and it always will be: no paid tier, no catch.

*Oh, by the way:* if GovernCode saves you an afternoon and you feel like saying thanks, you can
[buy Dave a coffee](https://buymeacoffee.com/onelegdave). The crew runs on tokens; Dave runs
on coffee. Only one of them has a button. Zero pressure: the code is yours either way.
