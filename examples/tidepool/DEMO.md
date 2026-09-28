# The GovernCode demo, with Tidepool

About fifteen minutes. Each step shows one part of GovernCode; the prompts are ready to paste
into the Dashboard's **Terminal** view (or `gov ask "..."` in a shell).

**You need:** GovernCode installed (`./install.sh` from a release), `govd` running, Claude Code
logged in (the Controller), and optionally Codex logged in and Ollama with `qwen3.5:9b` pulled
(the two Runners). Every AI step runs inside the sandbox, always.

## 0. A copy to work on

GovernCode works on a git project, so make your own copy of this folder:

```sh
cp -r tidepool ~/tidepool && cd ~/tidepool
git init -q && git add -A && git commit -qm "Tidepool, before the crew"
```

In the Dashboard: **Open folder** → `~/tidepool`. Pick **Claude Code** as the Controller.

## 1. The Controller, and a Gate

> Run the tests and tell me what fails, in one line.

The Controller wants to run `npm test`, so a **Gate** shows you exactly that command. Choose
**Allow for this turn**: the question goes away for the rest of the turn, the sandbox does not.
One test fails: a high tide in the second-to-last hour is missed.

## 2. A fix, and a Checkpoint

> Fix the bug that test found, then run the tests again.

It edits `src/tides.js` (the first edit asks: **Allow for this turn** again) and runs the
tests. Open **Checkpoints**: the turn's change is there, before and after. Try **Undo**,
look, then ask it to fix it again. Undo never overwrites a file you edited since.

## 3. Something that always asks

> The data file is old. Delete data/harbor.csv.

`rm` always asks, however you answered before. Say **Deny**. Nothing is deleted.

## 4. A job for a local model

> Use the governcode delegate tool to have ollama (model qwen3.5:9b) add a "Reading the
> output" section to README.md explaining high water, low water and range for someone who has
> never read a tide table. Scope: read ["src", "data"], write ["README.md"].

A **Spec** goes to the local model. It runs no commands and can only propose files inside its
scope; GovernCode checks every path. Open **Pipeline**: review the **Diff**, then **Accept** or
**Discard**. Nothing reached your folder until you chose.

## 5. A job for Codex, with its Limit

> Use the governcode delegate tool to have codex add a --json flag to src/cli.js that prints
> the high waters, low waters and range as JSON, with a test for it. Scope: read ["src",
> "test", "data"], write ["src/cli.js", "test"]. Keep it small.

Before it starts, GovernCode checks Codex's measured usage against the reserve you keep
(**Limits**). Codex works in its own copy, in its own sandbox; its steps show up as Gates marked
with the Spec. Review the diff in **Pipeline** and accept it.

## 6. Look around

- **Trace:** everything that happened, including every step allowed without asking.
- **Limits:** each Runner's usage and reserve; the local model's machine limit.
- **Settings:** quiet reads on or off, the local-model limits, each Runner's default model.

Then read the diff one last time. It works, and it's yours now.
