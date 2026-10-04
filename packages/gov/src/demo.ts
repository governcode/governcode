// `gov demo`: see GovernCode work in about five minutes. It makes a small sample project, has
// the Controller do one real task, hands one job to a Runner if one is available, and walks
// through review and undo. The sandbox is on for every step, exactly as in real use: the demo
// only picks sensible defaults and explains what is happening.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Params, SpecCheckpoints, SpecDiff } from "@governcode/protocol";

type Api = { call(method: string, params: unknown): Promise<any> };
type Tty = { next(prompt: string): Promise<string | null>; close(): void };   // null: no answer here
type Opts = { path?: string; tty: Tty; runAsk(api: any, project: string | null, prompt: string, tty: Tty): Promise<{ ok: boolean; summary: string }>;
  dim(s: string): string; warn(s: string): string };

const Review = SpecDiff.extend({ id: Params["spec.diff"].shape.id, checkpoints: SpecCheckpoints });

const FILES: Record<string, string> = {
  "README.md": "# Tide demo\n\nA tiny tide model, made by `gov demo` to show GovernCode at work.\n",
  "package.json": JSON.stringify({ name: "tide-demo", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  "src/tide.js": "// Water level (metres) at hour t, as a simple 12-hour cycle.\nexport function level(t) {\n  return 1.5 + 0.8 * Math.cos((2 * Math.PI * t) / 12);\n}\n",
  "test/tide.test.js": "import { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { level } from \"../src/tide.js\";\n\ntest(\"high water at hour 0\", () => assert.equal(level(0), 2.3));\n",
};

export async function runDemo(api: Api, o: Opts): Promise<number> {
  const { dim, warn } = o;
  const say = (s = "") => console.log(s);
  const step = (n: number, title: string) => say(warn(`\n── Step ${n} · ${title} ──`));

  const hello = await api.call("hello", { client: "gov-demo", protocol: 1 });
  if (!hello.sandbox?.ok) {
    say(`The sandbox is not verified on this machine (${hello.sandbox?.reason ?? "unknown"}), so GovernCode will not start any AI tool.`);
    say("That is on purpose: it fails closed. Run ./target/release/govern-sup selftest to see what is missing.");
    return 1;
  }
  // Checked before anything is made: the demo's Controller is Claude Code; Codex is optional.
  const tools = (await api.call("tools.list", {})).tools as Array<{ tool: string; connected: boolean }>;
  const connected = (tool: string) => tools.some((t) => t.tool === tool && t.connected);
  if (!connected("claude")) { say("Claude Code is not connected for GovernCode yet. Run gov connect claude, then gov demo again."); return 1; }
  const path = resolve(o.path ?? join(homedir(), "governcode-demo"));
  if (existsSync(path)) { say(`${path} already exists. Remove it, or pass another folder: gov demo --path DIR`); return 2; }

  say(warn("GovernCode demo"));
  say("You will watch an AI (the Controller) work on a small sample project, hand one job to a");
  say("second AI (a Runner) if one is set up, and then review and undo what they did.");
  say("");
  say(`${warn("The sandbox is on for every step, as always.")} Each AI can change only the demo folder. It`);
  say("can read what it needs to run (system files, its own login), but not your other projects, the rest");
  say("of your home folder, or GovernCode's own files; it cannot reach GovernCode to answer its own Gates.");
  say("When a step needs your OK, a Gate asks. You can answer:");
  say(`  ${warn("y")}  allow this one step   ${warn("t")}  allow this kind of step for the rest of this turn`);
  say(`  ${warn("p")}  remember it for this project   ${warn("N")}  deny`);
  say(dim("\"t\" and \"p\" only skip the question for that kind of step. They never widen the sandbox, and"));
  say(dim("every step is still recorded. Deleting, networking, changing the git repository, installing packages and"));
  say(dim("handing work to a paid AI always ask. How often the rest asks is yours to set: gov level relaxed|balanced|strict."));
  const ready = await o.tty.next("\nReady? [Y/n] ");
  // No input here: nobody to answer its Gates, so no paid turn is started.
  if (ready === null) { say(dim("no input here: gov demo needs you at the terminal; run it again there.")); return 1; }
  if (ready.trim().toLowerCase().startsWith("n")) return 0;

  step(1, "a sample project");
  mkdirSync(path, { recursive: true });
  for (const [file, text] of Object.entries(FILES)) { mkdirSync(join(path, file, ".."), { recursive: true }); writeFileSync(join(path, file), text); }
  const git = (...a: string[]) => execFileSync("git", ["-C", path, ...a], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=GovernCode demo", "-c", "user.email=demo@governcode.invalid", "commit", "-qm", "Tide demo");
  const taken = new Set(((await api.call("project.list", {})).projects as Array<{ name: string }>).map((p) => p.name));
  let name = "demo"; for (let n = 2; taken.has(name); n++) name = `demo-${n}`;
  await api.call("project.open", { path, name });
  await api.call("controller.set", { project: name, controller: { provider: "claude-code", model: "sonnet", effort: "medium" } });
  say(`Made ${path}: a tiny tide model with one test, as project ${warn(name)}.`);
  say(dim("Controller: Claude Code, Sonnet, medium effort (change it later with gov controller)."));

  step(2, "the Controller does a real task");
  say("It will add a function and a test, then run the tests. Try answering \"t\" at the first Gate for");
  say("file edits and for npm test: you will see the later ones go through without asking.");
  const first = await o.runAsk(api, name, "Add a function range(from, to) to src/tide.js that returns the lowest and highest level " +
    "for the whole hours from..to, with a test for it in test/tide.test.js. Then run npm test and tell me the result in one line.", o.tty);
  say(dim(first.ok ? "— done" : `— the turn ended: ${first.summary}`));

  step(3, "handing a job to a Runner");
  const runners = connected("codex") ? (await api.call("limits.list", { measure: true })).providers as Array<{ provider: string; verdict: { ok: boolean; reason?: string } }> : [];
  const codex = runners.find((r) => r.provider === "codex");
  let reviewed = false;
  if (!connected("codex")) {
    say("Skipped: Codex is not connected for GovernCode (gov connect codex, then run the demo again).");
  } else if (!codex?.verdict.ok) {
    say(`Skipped: ${codex ? `Codex is held (${codex.verdict.reason}).` : "no Runner is set up (install and log in to Codex to try this)."}`);
    // Only a Limit or budget hold is the Limit working; a Runner held without a reading says why above.
    if (codex?.verdict.reason?.startsWith("inside its ")) {
      say(dim("A held Runner is the Limit working: GovernCode starts no job that would reach into the reserve you"));
      say(dim("keep. Usage reports lag a little, so a job already running can overshoot slightly; it is stopped when seen."));
    }
  } else {
    say("The Controller hands one small job to Codex. Codex works in its own copy of the project, in its");
    say("own sandbox, and can only write the files the job allows. Nothing reaches your folder until you accept.");
    say(dim("A Runner starts from your last commit, so this job touches a file the Controller left alone."));
    const second = await o.runAsk(api, name, "Use the governcode delegate tool to have codex (model gpt-5.5, effort low, budget 5%) " +
      "add a short Usage section to README.md showing how to import and call level() from src/tide.js. " +
      "Scope: read [\"src\", \"README.md\"], write [\"README.md\"]. Reason: a small isolated job. Then just report the Spec id.", o.tty);
    say(dim(second.ok ? "— done" : `— the turn ended: ${second.summary}`));
    const specs = ((await api.call("spec.list", { project: name })).specs as Array<{ id: string; status: string }>).filter((s) => s.status === "needs-review");
    const spec = specs.at(-1);
    if (spec) {
      const id = spec.id;
      if (!Params["spec.diff"].safeParse({ id }).success) throw new Error("govd returned an invalid Spec id; not accepted");
      step(4, `reviewing ${id}`);
      const review = Review.safeParse(await api.call("spec.diff", { id }));
      if (!review.success || review.data.id !== id) throw new Error("govd returned no valid matching review checkpoints; not accepted (update GovernCode or review the Spec again)");
      // Keep the displayed snapshots across the prompt; a newer round needs a new review.
      const { diff, checkpoints } = review.data;
      if (!diff) {
        await api.call("spec.discard", { id });
        say("The Runner changed nothing, so there is nothing to review. (Discarded.)");
      } else {
        say(`${id}: ${checkpoints.before} → ${checkpoints.after}`);
        say(diff);
        const a = (await o.tty.next(`Accept ${id} into the project? [y/N] `))?.trim().toLowerCase();
        if (a === undefined) {
          say(dim(`no input here: ${id} waits for your review (gov accept ${id} or gov discard ${id})`));
        } else if (a.startsWith("y")) {
          const r = await api.call("spec.accept", { id, checkpoints });
          say(`Applied ${r.applied.length} file(s). ${dim("It is a plain change in your folder now; git sees it too.")}`);
        } else {
          await api.call("spec.discard", { id });
          say("Discarded. Nothing reached your folder.");
        }
      }
      reviewed = true;
    }
  }

  step(reviewed ? 5 : 4, "what you can do now");
  say(`  cd ${path}`);
  say(`  gov turns        the Controller's turns that changed files (Checkpoints)`);
  say(`  gov undo T-N     put those files back exactly, if you have not changed them since`);
  say(`  gov trace        everything that happened, including every step allowed without asking`);
  say(`  gov allows       the standing allows you remembered (revocable)`);
  say(`  npm start -w apps/dashboard   the same project in the Dashboard (from the GovernCode folder)`);
  say(dim(`\nWhen you are done with it: rm -rf ${path}`));
  return 0;
}
