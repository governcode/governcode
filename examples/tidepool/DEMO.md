# The GovernCode demo, with Tidepool

About fifteen minutes. Talk to the Controller in plain words; the prompts below are only
suggestions. Paste them into the Dashboard's **Terminal** view, or run `gov ask "..."` in a shell.

**You need:** GovernCode installed (`./install.sh` from a release), `govd` running, and Claude
Code logged in (the Controller). Optional: Codex logged in, and Ollama with a model pulled
(`ollama pull qwen3.5:9b`), for the two Runners. Every AI step runs inside the sandbox, always.

## 0. A copy to work on

GovernCode works on a git project, so make your own copy of this folder:

```sh
cp -r tidepool ~/tidepool && cd ~/tidepool
git init -q && git add -A && git commit -qm "Tidepool, before the crew"
```

In the Dashboard: **Open folder** → `~/tidepool`, and pick **Claude Code** as the Controller. The
first message asks whether to use your own Claude Code instructions: **Start clean** is right for
a demo.

## 1. Ask, and meet a Gate

> Run the tests and tell me what fails.

Reading files needs no question. Running `npm test` stops at a **Gate** showing exactly what will
run. Choose **Allow for this project**: `npm test` won't ask again here (Settings › Gates is on
**Balanced**; **Relaxed** asks less, **Strict** asks about everything). One test fails.

## 2. Carry on, and undo

> Fix it.

It remembers the conversation, so "it" is the failing test. The first file edit asks once (allow
it for the project). Then open **Checkpoints**: the change is there, before and after. Try
**Undo**, look, and ask it to fix it again. Undo never overwrites a file you edited since.

## 3. Something that always asks

> Delete the data file, we don't need it.

Deleting always asks, at every level. Say **Deny**. Nothing is deleted.

## 4. A job for a local model

> Have the local model add a short section to the README explaining how to read the output.

The Controller hands a **Spec** to the local model: no quota, no commands, and it can only
propose the files it was given. Open **Pipeline**, read the **Diff**, then **Accept** or
**Discard**. Small local models make mistakes; the Controller reviews the draft too, and can
throw a bad one away and try again.

## 5. A job for Codex

> Now have Codex add a --json flag to the CLI, with a test.

Handing work to a paid Runner always asks. GovernCode checks Codex's measured usage against the
reserve you keep (**Limits**), then Codex works in its own copy, in its own sandbox; its steps
show up as Gates marked with the Spec. Review the diff in **Pipeline** and accept it.

## 6. Look around

- **Trace:** everything that happened, including every step allowed without asking and why.
- **Settings:** how strict Gates are, your own instructions on or off, local-model limits.
- **New conversation** (Terminal) when you want the Controller to start fresh.

Then read the diff one last time. It works, and it's yours now.
