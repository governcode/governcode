#!/usr/bin/env node
// gov: the command line. A thin client of govd over its Unix socket. Gates are answered here,
// in the user's own terminal, which the sandboxed harness has no way to reach.
import { jsonLine, jsonLines } from "@governcode/protocol/lines";
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { COUNTED_LABEL, COUNTED_WINDOWS, Effort, Params, ProjectName, RUNNERS, SpecCheckpoints, SpecDiff, setBudget, type CountedWindow } from "@governcode/protocol";
import type { AcpStoredRuntimeObservation } from "../../govd/src/acp-install.ts";
import { runDemo } from "./demo.ts";
import { FRICTION_KINDS, friction, kindName, readTrace, type FrictionReport } from "@governcode/protocol/friction";
import { checkHost, localSocket, stateDir, tunnelSocket } from "./tunnel.ts";
import { hiddenCount, jsonShown, markCodes, oneLine, shown } from "./terminal.ts";

const env = process.env;
// The local govd's socket, or with `gov --host HOST ...` the one `gov tunnel HOST` forwards.
let socketPath = localSocket(env);
let host: string | null = null;

type Reply = { result?: any; error?: { code: number; message: string } };

const USAGE = "usage: gov [--host HOST] [status|projects|new NAME [--path P]|open [PATH [NAME]]|controller claude-code|codex [--model M] [--effort E]|trace [--jsonl]|friction [--project NAME] [--days N] [--json]|ask PROMPT|demo [--path P]|gates|gate ID allow|deny [--turn|--spec|--project]|plan ID approve [1,3]|just-you|reject|proposal ID create|cancel|allows [revoke R]|specs|diff S|accept S [--before OID --after OID]|discard S|cancel S|turns|undo T|limits|limited|resume ID [--at-reset|--off|--clear]|auto-resume on|off|settings|reserve P W N|budget [P W N tokens|turns|P [W] off]|local N M|memory [CHARS]|runner P --model M [--effort E]|spec-models free|within|defaults|spec-caps N M|level relaxed|balanced|strict|personal claude|codex on|off|acp search [QUERY]|acp inspect ID [--platform P] [--kind binary|npx|uvx]|acp install ID [--kind binary]|acp installed [--json]|acp inspect-installed INSTALLATION_ID [--json]|acp cancel I-N|connect [agy|claude|codex|grok|opencode]|disconnect agy|claude|codex|grok|opencode|notes [edit|history|restore SEQ]|crew [...]|reset|daemon start|install|uninstall|tunnel [HOST [--remote-socket P]|--stop HOST]|socket-path|help]";

// The commands that talk to govd: any other word gets the usage without connecting.
const COMMANDS = new Set(["status", "projects", "new", "open", "controller", "crew", "notes", "gates", "gate", "plan", "proposal", "allows",
  "turns", "undo", "settings", "budget", "local", "memory", "runner", "level", "personal", "connect", "disconnect", "reset", "spec-models", "reserve",
  "limits", "limited", "resume", "auto-resume", "specs", "diff", "accept", "discard", "cancel", "spec-caps", "trace", "friction", "ask", "demo", "acp"]);

/** A Runner name, checked before anything is saved (govd checks too): a typo would be saved and never used. */
function runner(name: string): string {
  if (!(RUNNERS as readonly string[]).includes(name)) throw new Error(`unknown Runner ${name} (Runners: ${RUNNERS.join(", ")})`);
  return name;
}

/** A project name, or the plain rule it breaks. */
function projectName(name: string): string {
  const bad = ProjectName.safeParse(name).error;
  if (bad) throw new Error(bad.issues[0].message);
  return name;
}

function open(): Promise<{ call(method: string, params?: unknown): Promise<any>; onEvent(f: (e: any) => void | Promise<void>): void; eventFailure: Promise<never>; sock: Socket }> {
  return new Promise((ok, fail) => {
    const sock = connect(socketPath);
    let next = 1;
    const waiting = new Map<number, (r: Reply) => void>();
    let listener: (e: any) => void | Promise<void> = () => {};
    let eventError: Error | undefined, rejectEvent!: (error: Error) => void;
    const eventFailure = new Promise<never>((_, reject) => { rejectEvent = reject; });
    // The command owns reporting and cleanup, even when its listener fails while awaiting input.
    const eventFailed = (error: unknown) => {
      if (eventError) return;
      eventError = error instanceof Error ? error : new Error(String(error));
      rejectEvent(eventError);
      sock.destroy();
    };
    eventFailure.catch(() => {});   // the command attaches its race after open resolves
    sock.once("error", () => fail(new Error(host ? `no tunnel to ${host} (no socket at ${socketPath}). Open one with: gov tunnel ${host}`
      : `govd is not running (no socket at ${socketPath}). Start it with: gov daemon start (or run govd in another terminal)`)));
    const lines = jsonLines(sock);
    lines.on("error", () => {});   // the socket's own error handler reports it
    lines.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.method === "event") {
        if (eventError) return;
        try { Promise.resolve(listener(msg.params)).catch(eventFailed); }
        catch (error) { eventFailed(error); }
        return;
      }
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    });
    // govd going away (a restart, a crash) fails every call still waiting: gov never hangs or exits quietly.
    sock.on("close", () => { for (const w of waiting.values()) w({ error: { code: -1, message: "govd closed the connection" } }); waiting.clear(); });
    sock.once("connect", () => ok({
      sock,
      eventFailure,
      onEvent: (f) => (listener = f),
      call: (method, params = {}) => new Promise((res, rej) => {
        if (eventError || sock.destroyed) return rej(eventError ?? new Error("govd closed the connection"));
        const id = next++;
        waiting.set(id, (r) => (r.error ? rej(new Error(r.error.message)) : res(r.result)));
        sock.write(jsonLine({ jsonrpc: "2.0", id, method, params }));
      }),
    }));
  });
}

// A line answers only the question on screen when it was typed. One typed with no question
// waiting, or in the first second a question is shown (it was meant for what was there before: a
// question since answered elsewhere, or none), is dropped and said so, never kept for the next
// question. Piped input is held to the same rule: it cannot see which question it would answer.
const SETTLE_MS = 1000;

/** Answers typed by the user, one line each, one question on screen at a time. null: no answer,
 *  so none is sent: nobody can answer here (end of input), or the question was withdrawn. */
function answers(): { next(prompt: string, withdrawn?: AbortSignal): Promise<string | null>; reshow(): void; close(): void } {
  type Question = { prompt: string; ok: (l: string | null) => void };
  const waiting: Question[] = [];
  let ended = false, onScreen = false, current: Question | null = null, shown = 0;
  // The first question waiting gets the prompt; a different one than before starts the clock again.
  const show = () => {
    if (onScreen || !waiting.length) return;
    if (waiting[0] !== current) { current = waiting[0]; shown = Date.now(); }
    process.stdout.write(current.prompt);
    onScreen = true;
  };
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (l) => {
    if (!waiting.length) { if (l.trim()) console.log(dim("ignored: no question was waiting")); return; }
    onScreen = false;
    if (Date.now() - shown < SETTLE_MS) { console.log(dim("ignored: typed before this question was shown; answer again")); return show(); }
    waiting.shift()!.ok(l);
    show();
  });
  // A prompt still on screen gets its line ended, so what follows starts on a new one.
  rl.on("close", () => { ended = true; if (onScreen) process.stdout.write("\n"); onScreen = false; while (waiting.length) waiting.shift()!.ok(null); });
  return {
    next: (prompt, withdrawn) => {
      if (ended) return Promise.resolve(null);
      return new Promise((ok) => {
        const q = { prompt, ok };
        waiting.push(q);
        show();
        // Withdrawn (answered elsewhere): its prompt goes, the reason (a string) is said, and the
        // question now first is shown.
        withdrawn?.addEventListener("abort", () => {
          const i = waiting.indexOf(q);
          if (i < 0) return;
          waiting.splice(i, 1);
          if (onScreen) process.stdout.write("\n");
          onScreen = false;
          if (typeof withdrawn.reason === "string") console.log(withdrawn.reason);
          show();
          ok(null);
        }, { once: true });
      });
    },
    /** The waiting question's prompt again, below whatever buried it; its clock starts again. */
    reshow: () => { if (!waiting.length) return; if (onScreen) process.stdout.write("\n"); onScreen = false; current = null; show(); },
    close: () => rl.close(),
  };
}

const PROVIDER_NAMES: Record<string, string> = { "claude-code": "Claude Code (Anthropic)", codex: "Codex (OpenAI)" };
// What gov controller sets without --model or --effort (the models the Dashboard suggests first).
const CONTROLLER_DEFAULTS: Record<string, { model: string; effort: string }> = { "claude-code": { model: "opus", effort: "high" }, codex: { model: "gpt-5.5", effort: "medium" } };
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const warn = (s: string) => `\x1b[33m${s}\x1b[0m`;
const resetWhen = (iso: string) => {
  const at = new Date(iso), minutes = Math.ceil((at.getTime() - Date.now()) / 60_000);
  // A reset more than a day away names its day too.
  const day = minutes > 24 * 60 ? `${at.toLocaleDateString("en-US", { weekday: "short" })} ` : "";
  const clock = `${day}${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  if (minutes <= 0) return `resets ${clock} (passed)`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return `resets ${clock} (in ${[hours ? `${hours} h` : "", rest ? `${rest} min` : ""].filter(Boolean).join(" ")})`;
};
// A tool's own "open this URL" line before its link (Grok's, Codex's): gov says it once, with the
// link. Only a whole line of these fixed words is left out, so no code, link or error is hidden.
const PREAMBLE = /^(to sign in, |if your browser did not open, )?(open|navigate to) this url( in your browser)?( to authenticate)?:$/i;

/** The first time a Controller works, ask once whether the user's own instructions come along
 *  (off by default; said plainly both ways). */
async function askPersonal(api: Awaited<ReturnType<typeof open>>, provider: "claude" | "codex", tty: ReturnType<typeof answers>): Promise<void> {
  const { settings } = await api.call("settings.get", {});
  if (settings.personal?.[provider] !== null) return;
  const tool = provider === "codex" ? "Codex" : "Claude Code";
  const files = provider === "codex" ? "your AGENTS.md" : "your CLAUDE.md, skills, agents, commands, plugins and hooks";
  console.log(warn(`\nUse your own ${tool} instructions in GovernCode?`));
  console.log(`  No (the default): ${tool} starts clean, from its own defaults and GovernCode's instructions only.`);
  console.log(`  Yes: it reads ${files}, as it does outside GovernCode, so what you have built up comes along.`);
  console.log(dim("  The sandbox and Gates apply the same either way. Change it later: gov personal " + provider + " on|off"));
  const a = (await tty.next("Use your own instructions? [y/N] "))?.trim().toLowerCase();
  if (a === undefined) { console.log(dim(`no input here: off for now, and asked again next time (gov personal ${provider} on|off sets it)`)); return; }
  await api.call("settings.set", { ...settings, personal: { ...settings.personal, [provider]: a === "y" || a === "yes" } });
}

/** One Controller turn in the terminal: text streams, Gates ask (with standing-allow choices). */
export async function runAsk(api: Awaited<ReturnType<typeof open>>, project: string | null, prompt: string,
    tty: ReturnType<typeof answers>, extra: { continuationOf?: string } = {}): Promise<{ ok: boolean; summary: string }> {
  // The tool this turn runs (the project's Controller, or Home's) is asked about only once it is
  // connected; otherwise govd refuses the turn and says how to connect, and nothing is asked first.
  const { projects, home } = await api.call("project.list", {});
  const provider = (project ? projects.find((p: any) => p.name === project)?.controller : home?.controller)?.provider === "codex" ? "codex" : "claude";
  const { tools } = await api.call("tools.list", {});
  if (tools.some((t: any) => t.tool === provider && t.connected)) await askPersonal(api, provider, tty);
  // Questions shown here and not answered yet, by id: the prompt's withdrawal, or null once left
  // open (no input here) for another terminal (a Gate in the Dashboard too). gov never sends an
  // answer the user did not give; one answered elsewhere is withdrawn and named.
  const open = new Map<string, AbortController | null>();
  const question = async (id: string, prompt: string, elsewhere: string): Promise<string | undefined> => {
    const withdraw = new AbortController();
    open.set(id, withdraw);
    const a = await tty.next(prompt, withdraw.signal);
    if (a !== null) open.delete(id);
    else if (open.get(id) === withdraw) { open.set(id, null); console.log(dim(`no input here: answer from another terminal with ${elsewhere}`)); }
    return a?.trim().toLowerCase();
  };
  const failed = (id: string) => (e: Error) => console.log(dim(`${oneLine(id)}: ${oneLine(e.message)}`));
  const PLAN_ANSWERS: Record<string, string> = { approve: "approved", "just-you": "answered just you", reject: "rejected" };
  const proposals: Promise<void>[] = [];   // a proposal outlives the turn (govd keeps it until answered)
  const handed = new Set<string>();        // Specs this turn handed off (they may outlive it)
  const proposal = async (ev: any) => {
    console.log(warn(`\nThe Controller proposes a new project: ${oneLine(ev.name)} at ${oneLine(ev.path)}${ev.git ? " (git init, branch main)" : ""}`));
    if (ev.reason) console.log(dim(shown(ev.reason)));
    const a = await question(ev.id, `Create ${oneLine(ev.name)}? [y/N] `, `gov proposal ${oneLine(ev.id)} create|cancel`);
    if (a === undefined) return;
    await api.call("proposal.answer", { id: ev.id, answer: a === "y" || a === "yes" ? "create" : "cancel" })
      .then((r) => console.log(dim(r.created ? `created ${oneLine(r.created.name)} at ${oneLine(r.created.path)} (cd there to work in it)` : "not created")), failed(ev.id));
  };
  api.onEvent(async (ev) => {
    if (ev.kind === "text") process.stdout.write(shown(ev.text) + "\n");
    else if (ev.kind === "tool") console.log(dim(`· ${oneLine(ev.name)}`));
    else if (ev.kind === "spec") { handed.add(ev.id); console.log(warn(`\n${oneLine(ev.id)} → Runner · ${oneLine(ev.to)}: ${shown(ev.brief)}`)); }
    else if (ev.kind === "spec.text") console.log(dim(`  ${oneLine(ev.id)} · ${shown(ev.text.slice(0, 200))}`));
    else if (ev.kind === "spec.tool") console.log(dim(`  ${oneLine(ev.id)} · ${oneLine(ev.name)}`));
    else if (ev.kind === "gate") {
      const runner = /\(Runner · ([^,]+), (S-\d+)\)$/.exec(String(ev.tool));
      console.log(warn(runner ? `\nGate: Runner ${oneLine(runner[1])} (${oneLine(runner[2])}) wants to use ${oneLine(String(ev.tool).replace(runner[0], "").trim())}. Exactly this will run:`
                              : `\nGate: the Controller wants to use ${oneLine(ev.tool)}. Exactly this will run:`));
      console.log(shown(ev.canonical));
      // Standing allows skip the question for this kind of step; the sandbox still applies.
      const scopes: string[] = ev.scopes ?? [];
      const keys: Record<string, string> = { turn: "t", spec: "s", project: "p" };
      if (scopes.length) console.log(dim(`  Also allow ${oneLine(String(ev.covers))} for: ${scopes.map((s) => `[${keys[s]}] this ${oneLine(s)}`).join(", ")}.` +
        " That only skips this question; the sandbox still applies to every step."));
      if (ev.suggest) console.log(dim(`  Suggested: [${keys[ev.suggest]}], so this kind of step stops asking in this ${oneLine(ev.suggest)}.`));
      const choices = ["y", ...scopes.map((s) => keys[s])].join("/");
      const a = await question(ev.id, `Allow ${oneLine(ev.id)}? [${choices}/N] `, `gov gate ${oneLine(ev.id)} allow|deny`);
      if (a === undefined) return;
      if (!a) console.log("");
      const remember = scopes.find((s) => keys[s] === a);
      await api.call("gate.answer", { id: ev.id, answer: a === "y" || a === "yes" || remember ? "allow" : "deny", ...(remember ? { remember } : {}) }).catch(failed(ev.id));
    } else if (ev.kind === "allowed") {
      console.log(dim(`· allowed without asking: ${shown(ev.why)} (the sandbox still applies)`));
    } else if (ev.kind === "plan") {
      console.log(warn(`\nGame plan ${oneLine(ev.id)}: who does what`));
      ev.items.forEach((it: any, i: number) => console.log(`  ${i + 1}. ${it.who === "me" ? "Controller" : oneLine(it.who)}: ${shown(it.what)}${it.scope?.length ? dim(` (${it.scope.map(oneLine).join(", ")})`) : ""}`));
      if (ev.note) console.log(dim(`  ${shown(ev.note)}`));
      console.log(dim(ev.handoff === "plan" ? "  Each approved handoff runs once without asking again; anything else still asks." : "  Handoffs still ask at a Gate (Crew card: ask each time)."));
      // Items outside the plan would be refused, leaving it waiting with no question here: asked again.
      let a: string | undefined, nums: number[] | null;
      for (;;) {
        a = await question(ev.id, `Approve ${oneLine(ev.id)}? [y = all / 1,3 = only those / j = just you / N] `, `gov plan ${oneLine(ev.id)} approve [1,3]|just-you|reject`);
        if (a === undefined) return;
        nums = /^\d+(\s*,\s*\d+)*$/.test(a) ? a.split(",").map((x) => Number(x.trim())) : null;
        if (!nums || nums.every((n) => n >= 1 && n <= ev.items.length)) break;
        console.log(dim(`the items are 1 to ${ev.items.length}`));
      }
      await api.call("plan.answer", { id: ev.id, ...(a === "y" || a === "yes" ? { answer: "approve" } : nums ? { answer: "approve", items: nums } : a === "j" ? { answer: "just-you" } : { answer: "reject" }) })
        .catch(failed(ev.id));
    } else if (ev.kind === "proposal") {
      const pending = proposal(ev);
      proposals.push(pending);
      await pending;   // the dispatcher catches a failure even before the turn finishes
    } else if (ev.kind === "trace") {
      // A question shown here was answered elsewhere (another terminal, the Dashboard) or ended with the turn.
      const e = ev.event, d = e.data, id = d.gate ?? d.plan ?? d.proposal;
      const what = e.kind === "gate.allowed" ? "allowed" : e.kind === "gate.denied" ? "denied" : e.kind === "plan.answered" ? PLAN_ANSWERS[d.answer] ?? d.answer
        : e.kind === "project.created" ? "created" : e.kind === "project.declined" ? "not created" : null;
      if (!what || !open.has(id)) return;
      const w = open.get(id);
      open.delete(id);
      const note = dim(`${oneLine(id)}: ${oneLine(what)} ${d.by === undefined || d.by === "user" ? "from elsewhere" : `(${oneLine(d.by)})`}`);
      if (w) w.abort(note); else console.log(note);
    }
  });
  // Every Trace event from here on, for the answers given elsewhere (an older govd: none are seen).
  // (wake false: gov shows no wake turns, so it is not someone there to see one.)
  await api.call("watch", { wake: false }).catch(() => {});
  let r;
  try { r = await api.call("ask", { project, prompt, ...extra }); }
  finally { for (const [id, w] of open) if (!id.startsWith("P-")) { open.delete(id); w?.abort(); } }   // the turn's Gates and plans end with it
  // Specs this turn handed off may still be running: they go on after gov exits.
  if (handed.size && project) {
    const { specs } = await api.call("spec.list", { project }).catch(() => ({ specs: [] }));
    const running = specs.filter((x: any) => handed.has(x.id) && ["running", "queued"].includes(x.status)).map((x: any) => `${oneLine(x.id)} (${oneLine(x.to)})`);
    if (running.length) console.log(dim(`\nStill running: ${running.join(", ")}. They go on without this terminal: gov specs shows them, ` +
      "gov gates lists any step waiting for your answer, gov cancel stops one; the Controller hears how they went (with the Dashboard open, by itself; else with your next message)."));
  }
  // A proposal's question stays after the turn, shown again below the Controller's last words.
  tty.reshow();
  await Promise.all(proposals);
  return r;
}

async function installAcpInTerminal(api: Awaited<ReturnType<typeof open>>, id: string, kind: "binary" | "npx" | "uvx",
  explicitFingerprint?: string): Promise<number> {
  const inspected = await api.call("acp.inspect", { id, kind });
  if (!inspected.installation?.supported || !inspected.executor?.supported)
    throw new Error(inspected.installation?.reason ?? inspected.executor?.reason ?? "this govd does not support artifact storage");
  const fingerprint = explicitFingerprint ?? inspected.fingerprint;
  if (!/^[a-f0-9]{64}$/.test(fingerprint ?? "") || (explicitFingerprint && explicitFingerprint !== inspected.fingerprint))
    throw new Error("the installation changed since inspection; inspect it again");
  const tty = answers(), questions = new Map<string, AbortController>();
  api.onEvent(async (event) => {
    if (event.kind === "acp.install") console.log(`Installation ${oneLine(event.id)} (cancel with gov acp cancel ${oneLine(event.id)})`);
    else if (event.kind === "gate") {
      console.log(warn(`\nArtifact installation Gate ${oneLine(event.id)}:`));
      console.log(shown(event.canonical));
      const withdrawn = new AbortController();
      questions.set(event.id, withdrawn);
      const line = process.stdin.isTTY === true ? await tty.next(`Allow ${oneLine(event.id)}? [y/N] `, withdrawn.signal) : null;
      if (withdrawn.signal.aborted) return;
      if (line === null) {
        console.log(dim(`no input here: answer with gov gate ${oneLine(event.id)} allow|deny from another terminal`));
        return;
      }
      questions.delete(event.id);
      const answer = line.trim().toLowerCase();
      await api.call("gate.answer", { id: event.id, answer: answer === "y" || answer === "yes" ? "allow" : "deny" })
        .catch((error: Error) => console.log(dim(`${oneLine(event.id)}: ${oneLine(error.message)}`)));
    } else if (event.kind === "trace" && ["gate.allowed", "gate.denied"].includes(event.event.kind)) {
      const gate = event.event.data.gate, pending = questions.get(gate);
      if (pending) { questions.delete(gate); pending.abort(); console.log(dim(`${oneLine(gate)}: answered elsewhere`)); }
    }
  });
  try {
    await api.call("watch", { wake: false });
    const { receipt } = await api.call("acp.install", { id, kind, fingerprint });
    console.log(`Stored ${oneLine(receipt.plan.agentId)} ${oneLine(receipt.plan.version)} (registry-advertised) · ${receipt.bytes} bytes\nInstallation: ${oneLine(receipt.installationId)}\nSHA-256: ${oneLine(receipt.sha256)}`);
    return 0;
  } finally {
    for (const question of questions.values()) question.abort();
    tty.close();
  }
}

async function currentProject(api: Awaited<ReturnType<typeof open>>): Promise<string | null> {
  const here = resolve(process.cwd());
  const { projects } = await api.call("project.list");
  const match = projects.filter((p: any) => here === p.path || here.startsWith(p.path + "/")).sort((a: any, b: any) => b.path.length - a.path.length)[0];
  return match?.name ?? null;
}

async function main(argv: string[]): Promise<number> {
  markCodes(process.stdout.isTTY === true);   // hidden characters' codes in inverse video on a terminal
  if (argv[0] === "--host") {
    host = checkHost(argv[1]);
    socketPath = tunnelSocket(host, env);
    argv = argv.slice(2);
  }
  const [cmd, ...rest] = argv;
  if (cmd === "help" || cmd === "--help" || cmd === "-h") { console.log(USAGE); return 0; }
  if (cmd === "daemon") return daemon(rest[0]);
  if (cmd === "socket-path") { console.log(oneLine(socketPath)); return 0; }
  if (cmd === "tunnel") {
    // gov tunnel HOST [--remote-socket PATH] | gov tunnel --stop HOST | gov tunnel (the open ones)
    const t = await import("./tunnel.ts");
    if (host) throw new Error("gov tunnel takes the host itself: gov tunnel HOST");
    if (rest[0] === "--stop") { console.log(shown(t.stopTunnel(rest[1], env))); return 0; }
    if (!rest.length) { const rows = t.listTunnels(env); console.log(rows.length ? rows.map(oneLine).join("\n") : dim("no tunnels (gov tunnel HOST opens one)")); return 0; }
    const i = rest.indexOf("--remote-socket");
    if (rest.length !== (i >= 0 ? 3 : 1) || (i >= 0 && i !== 1)) throw new Error("usage: gov tunnel HOST [--remote-socket PATH] | gov tunnel --stop HOST | gov tunnel");
    return t.runTunnel(rest[0], i >= 0 ? rest[i + 1] : undefined, env);
  }
  if (cmd !== undefined && !COMMANDS.has(cmd)) { console.error(USAGE); return 2; }
  const api = await open();
  const command = async (): Promise<number> => {
    switch (cmd) {
      case undefined:
      case "status": {
        const h = await api.call("hello", { client: "gov", protocol: 1 });
        const project = await currentProject(api);
        console.log(`govd ${oneLine(h.version)} · protocol ${h.protocol} · sandbox: ${h.sandbox.ok ? "enforced (self-test passed)" : warn("NOT verified: " + oneLine(h.sandbox.reason))}`);
        console.log(project ? `project: ${oneLine(project)}` : dim("no project here (Home). gov open PATH or gov new NAME"));
        return 0;
      }
      case "projects": {
        const { projects } = await api.call("project.list");
        for (const p of projects) console.log(`${oneLine(p.name).padEnd(14)} ${oneLine(p.path)}  ${dim(`${[p.controller.provider, p.controller.model || "default model", p.controller.effort].filter((x): x is string => Boolean(x)).map(oneLine).join(" · ")}`)}`);
        if (!projects.length) console.log(dim("no projects yet"));
        return 0;
      }
      case "new": {
        const name = rest[0];
        const at = rest.indexOf("--path");
        if (!name || name.startsWith("-") || (at >= 0 && !rest[at + 1])) throw new Error("usage: gov new NAME [--path P] [--no-git]");
        projectName(name);
        const path = at >= 0 ? rest[at + 1] : join(process.cwd(), name);
        const { project } = await api.call("project.new", { name, path, git: !rest.includes("--no-git") });
        // Already registered: nothing to open, only somewhere to go.
        console.log(`created ${oneLine(project.name)} at ${oneLine(project.path)} (cd there to work in it)`);
        return 0;
      }
      case "open": {
        const path = resolve(rest[0] ?? ".");
        const { project } = await api.call("project.open", { path, name: rest[1] === undefined ? undefined : projectName(rest[1]) });
        console.log(`opened ${oneLine(project.name)} (${oneLine(project.path)})`);
        return 0;
      }
      case "controller": {
        // Checked before anything is asked or recorded. "claude" is the name connect and personal use.
        const provider = rest[0] === "claude" ? "claude-code" : rest[0];
        const flag = (f: string) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] ?? "" : undefined; };
        const d = provider && Object.hasOwn(CONTROLLER_DEFAULTS, provider) ? CONTROLLER_DEFAULTS[provider] : null;
        const model = flag("--model") ?? d?.model, effort = flag("--effort") ?? d?.effort;
        if (!d || !model || !Effort.safeParse(effort).success) throw new Error("usage: gov controller claude-code|codex [--model M] [--effort low|medium|high|max]");
        const project = await currentProject(api);
        if (!project) throw new Error("run this inside a project folder");
        // Project memory goes to another provider only if the user says so, once per project.
        const ctx = await api.call("context.state", { project });
        if (ctx.providers.some((x: string) => x !== provider) && ctx.shared[provider] === undefined) {
          const tty = answers();
          const who = PROVIDER_NAMES[provider] ?? provider;
          console.log(warn(`\n${who} will see this project's conversation, its record (${ctx.specs} Specs, ${ctx.checkpoints} Checkpoints) and its notes${ctx.notes ? ":" : " (none yet)."}`));
          if (ctx.notes) console.log(dim(ctx.notes.split("\n").slice(0, 8).map((l: string) => "  " + shown(l)).join("\n") + (ctx.notes.split("\n").length > 8 ? "\n  …" : "")));
          console.log(dim("  Yes: it picks up where the last Controller left off. No: it starts fresh here, with only its own turns."));
          const a = (await tty.next("Share this project's context with it? [y/N] "))?.trim().toLowerCase();
          tty.close();
          if (a === undefined) console.log(dim("no input here: nothing is shared, so it starts fresh; run gov controller again in a terminal to choose"));
          else await api.call("context.share", { project, provider, share: a === "y" || a === "yes" });
        }
        await api.call("controller.set", { project, controller: { provider, model, effort } });
        console.log(`Controller for ${oneLine(project)}: ${provider} · ${oneLine(model)} · ${effort}`);
        return 0;
      }
      case "crew": {
        // gov crew: this project's Crew card. Set a part: works on|off, handoff ask|plan|off,
        // runners all|codex,agy, max RUNNER N|none, subagents controller|runners on|off,
        // wake auto|tell|off (how the Controller hears that a Spec finished).
        const project = await currentProject(api);
        if (!project) throw new Error("run this inside a project folder");
        const { crew } = await api.call("crew.get", { project });
        const [what, a, b] = rest;
        const usage = "usage: gov crew [works on|off | handoff ask|plan|off | runners all|R1,R2 | max RUNNER 1-25|none | subagents controller|runners on|off | wake auto|tell|off]";
        if (what) {
          if (what === "works" && ["on", "off"].includes(a)) crew.controllerWorks = a === "on";
          else if (what === "handoff" && ["ask", "plan", "off"].includes(a)) crew.handoff = a;
          else if (what === "runners" && a) crew.runners = a === "all" ? null : a.split(",").map((x: string) => x.trim()).filter(Boolean).map(runner);
          else if (what === "max" && a && b === "none") delete crew.maxPercent[a];
          else if (what === "max" && a && Number.isInteger(Number(b)) && Number(b) >= 1 && Number(b) <= 25) crew.maxPercent[runner(a)] = Number(b);
          else if (what === "subagents" && ["controller", "runners"].includes(a) && ["on", "off"].includes(b)) crew.subagents[a] = b === "on";
          else if (what === "wake" && ["auto", "tell", "off"].includes(a) && crew.wake !== undefined) crew.wake = a;
          else throw new Error(usage);
          await api.call("crew.set", { project, crew });
        }
        const HANDOFF: Record<string, string> = { ask: "ask me each time", plan: "follow the approved plan", off: "off (the Controller works alone)" };
        console.log(`Crew card for ${oneLine(project)}`);
        console.log(`  Controller     ${crew.controllerWorks ? "works itself and hands off" : "plans and hands off only (the project is read-only for it)"}`);
        console.log(`  Handing off    ${HANDOFF[crew.handoff]}`);
        console.log(`  Runners        ${crew.runners ? crew.runners.map(oneLine).join(", ") || "none" : "all connected Runners"}`);
        const caps = Object.entries(crew.maxPercent).map(([r, n]) => `${oneLine(r)} ${n}%`).join(", ");
        console.log(`  Most per Spec  ${caps || "the Runner's Limit (25% at most)"}`);
        console.log(`  Subagents      Controller ${crew.subagents.controller ? "on" : "off"} · Runners ${crew.subagents.runners ? "on" : "off"}`);
        const WAKE: Record<string, string> = { auto: "the Controller reports it by itself while the Dashboard is open", tell: "the Controller hears with your next message", off: "the Controller is not told" };
        if (crew.wake !== undefined) console.log(`  Spec finished  ${WAKE[crew.wake]}`);
        if (!what) console.log(dim(usage));
        return 0;
      }
      case "notes": {
        // gov notes: this project's notes; edit (in $EDITOR), history, restore SEQ.
        const project = await currentProject(api);
        if (!project) throw new Error("run this inside a project folder");
        const n = await api.call("notes.get", { project, limit: rest[0] === "restore" ? 1000 : 50 });
        if (!rest[0]) { console.log(n.text ? shown(n.text) : dim("no notes yet (the Controller writes them with project_notes; gov notes edit to write your own)")); return 0; }
        if (rest[0] === "history") {
          for (const h of n.history) console.log(`${oneLine(String(h.seq)).padStart(6)}  ${new Date(h.ts).toTimeString().slice(0, 8)}  ${oneLine(h.actor).padEnd(22)} ${h.text.length} chars`);
          return 0;
        }
        if (rest[0] === "restore") {
          const v = n.history.find((h: any) => String(h.seq) === rest[1]);
          if (!v) throw new Error("usage: gov notes restore SEQ   (see gov notes history)");
          await api.call("notes.set", { project, text: v.text });
          console.log(`notes restored to version ${oneLine(String(v.seq))}`);
          return 0;
        }
        if (rest[0] === "edit") {
          const dir = mkdtempSync(join(tmpdir(), "gov-notes-"));
          const file = join(dir, "notes.md");
          writeFileSync(file, n.text, { mode: 0o600 });
          const r = spawnSync(env.EDITOR || env.VISUAL || "nano", [file], { stdio: "inherit" });
          const text = readFileSync(file, "utf8");
          rmSync(dir, { recursive: true, force: true });
          if (r.status !== 0) throw new Error("the editor did not finish; notes unchanged");
          if (text === n.text) { console.log(dim("unchanged")); return 0; }
          await api.call("notes.set", { project, text });
          console.log(`notes saved (${text.length} chars)`);
          return 0;
        }
        throw new Error("usage: gov notes [edit|history|restore SEQ]");
      }
      case "gates": {
        const { gates } = await api.call("gate.list");
        if (!gates.length) console.log(dim("no Gates waiting"));
        for (const g of gates) {
          console.log(warn(`${oneLine(g.id)}  ${oneLine(g.project ?? "Home")} · ${oneLine(g.tool)} · opened ${new Date(g.opened).toTimeString().slice(0, 8)}`));
          console.log(shown(g.canonical));
        }
        return 0;
      }
      case "gate": {
        const [id, answer, flag] = rest;
        const remember = flag === "--turn" ? "turn" : flag === "--spec" ? "spec" : flag === "--project" ? "project" : undefined;
        if (!/^G-\d+$/.test(id ?? "") || (answer !== "allow" && answer !== "deny") || (flag && !remember)) throw new Error("usage: gov gate G-N allow|deny [--turn|--spec|--project]");
        await api.call("gate.answer", { id, answer, ...(remember ? { remember } : {}) });
        console.log(`${id}: ${answer === "deny" ? "denied" : remember ? `allowed, and this kind of step for the rest of this ${remember} (the sandbox still applies)` : "allowed once"}`);
        return 0;
      }
      case "plan": {
        // gov plan GP-N approve [1,3]|just-you|reject: a game plan gov ask could not ask about.
        const [id, answer, items] = rest;
        if (!/^GP-\d+$/.test(id ?? "") || rest.length > 3 || !["approve", "just-you", "reject"].includes(answer) || (items !== undefined && (answer !== "approve" || !/^\d+(,\d+)*$/.test(items)))) {
          throw new Error("usage: gov plan GP-N approve [1,3]|just-you|reject");
        }
        const r = await api.call("plan.answer", { id, answer, ...(items ? { items: items.split(",").map(Number) } : {}) });
        // What govd approved, not what was typed.
        const approved = r.approved ? `approved: ${r.approved.length ? `item${r.approved.length === 1 ? "" : "s"} ${r.approved.map((n: number) => oneLine(String(n))).join(", ")}` : "nothing"}` : "approved";
        console.log(`${id}: ${answer === "approve" ? approved : answer === "just-you" ? "just you (the Controller does it all itself this turn)" : "rejected"}`);
        return 0;
      }
      case "proposal": {
        // gov proposal P-N create|cancel: a Home Controller's proposal gov ask could not ask about.
        const [id, answer] = rest;
        if (!/^P-\d+$/.test(id ?? "") || (answer !== "create" && answer !== "cancel")) throw new Error("usage: gov proposal P-N create|cancel");
        const r = await api.call("proposal.answer", { id, answer });
        console.log(r.created ? `created ${oneLine(r.created.name)} at ${oneLine(r.created.path)} (cd there to work in it)` : `${id}: not created`);
        return 0;
      }
      case "allows": {
        // gov allows [revoke R-N]: the standing allows remembered for projects.
        if (rest[0] === "revoke") {
          if (!/^R-\d+$/.test(rest[1] ?? "")) throw new Error("usage: gov allows revoke R-N (see gov allows)");
          await api.call("allows.revoke", { id: rest[1] });
          console.log(`${rest[1]} revoked: that kind of step asks again`);
          return 0;
        }
        const project = await currentProject(api);
        const { rules } = await api.call("allows.list", project ? { project } : {});
        if (!rules.length) console.log(dim("no standing allows remembered for projects"));
        for (const r of rules) console.log(`${oneLine(r.id)}  ${oneLine(r.project ?? "").padEnd(14)} ${oneLine(r.label)}`);
        if (rules.length) console.log(dim("These only skip the question. The sandbox still applies to every step. Revoke with gov allows revoke R-N."));
        return 0;
      }
      case "turns": {
        const project = await currentProject(api);
        if (!project) throw new Error("run this inside a project folder");
        const { turns } = await api.call("turn.list", { project });
        if (!turns.length) console.log(dim("no Checkpoints yet (a turn that changed nothing records none)"));
        for (const t of turns) console.log(`${oneLine(t.id).padEnd(8)} ${new Date(t.at).toTimeString().slice(0, 8)}  ${t.files.length} file(s)  ${dim(t.files.slice(0, 4).map(oneLine).join(", "))}`);
        return 0;
      }
      case "undo": {
        if (!/^T-\d+$/.test(rest[0] ?? "")) throw new Error("usage: gov undo T-N (see gov turns)");
        const r = await api.call("turn.undo", { id: rest[0] });
        console.log(`${oneLine(r.id)}: restored ${r.restored.length} file(s): ${r.restored.map(oneLine).join(", ")}`);
        return 0;
      }
      case "settings": {
        const { settings } = await api.call("settings.get", {});
        const rows = Object.entries(settings.reserves as Record<string, Record<string, number>>);
        if (!rows.length) console.log(dim("defaults: every Runner keeps 10% of each usage window back"));
        for (const [provider, windows] of rows) console.log(`${oneLine(provider).padEnd(8)} ${Object.entries(windows).map(([w, n]) => `${oneLine(w)} ${n}%`).join(", ")}`);
        for (const [provider, d] of Object.entries(settings.runners as Record<string, { model: string; effort: string | null }>)) console.log(`${oneLine(provider).padEnd(8)} defaults to ${[d.model || "default model", d.effort].filter((x): x is string => Boolean(x)).map(oneLine).join(" · ")}`);
        console.log(`per-Spec models: ${oneLine(settings.specModels)}`);
        for (const [provider, b] of Object.entries(settings.budgets as Record<string, { unit: string; windows: Record<string, number> }>)) {
          if (!Object.keys(b.windows).length) continue;
          console.log(`${oneLine(provider).padEnd(8)} budget ${Object.entries(b.windows).map(([w, n]) => `${n} ${oneLine(b.unit)} ${oneLine(w)}`).join(", ")} ${dim(`(${COUNTED_LABEL})`)}`);
        }
        console.log(`local models: at most ${settings.local.maxRunning} at once, ${settings.local.maxMinutes} min each`);
        console.log(`recent conversation: up to ${settings.memory.conversationChars} characters per turn`);
        if (settings.specs) console.log(`Specs at once: up to ${settings.specs.maxPerProject} per project, ${settings.specs.maxPerRunner} per Runner`);
        if (settings.recovery?.autoResume !== undefined) console.log(`auto-resume: ${settings.recovery.autoResume ? "on" : "off"}`);
        return 0;
      }
      case "auto-resume": {
        const state = rest[0];
        if (rest.length !== 1 || (state !== "on" && state !== "off")) throw new Error("usage: gov auto-resume on|off");
        const hello = await api.call("hello", { client: "gov", protocol: 1 });
        if (!hello.features?.includes("recovery")) throw new Error("this govd has no usage-limit recovery (update GovernCode)");
        const { settings } = await api.call("settings.get", {});
        await api.call("settings.set", { ...settings, recovery: { autoResume: state === "on" } });
        console.log(`auto-resume: ${state}`);
        return 0;
      }
      case "memory": {
        // gov memory 24000: how much of the recent conversation each Controller turn gets (whole
        // messages only; the rest is left out whole and readable with conversation_read).
        if (rest.length > 1 || (rest.length === 1 && !/^\d+$/.test(rest[0]))) throw new Error("usage: gov memory [CHARS]   (2000-48000; without CHARS, the current budget)");
        const { settings } = await api.call("settings.get", {});
        if (!rest.length) { console.log(`recent conversation: up to ${settings.memory.conversationChars} characters per turn`); return 0; }
        const chars = Number(rest[0]);
        if (chars < 2000 || chars > 48_000) throw new Error("usage: gov memory [CHARS]   (2000-48000; without CHARS, the current budget)");
        await api.call("settings.set", { ...settings, memory: { conversationChars: chars } });
        console.log(`recent conversation: up to ${chars} characters per turn`);
        return 0;
      }
      case "budget": {
        // gov budget codex daily 20 turns: at most 20 Runner turns a day, counted by GovernCode.
        // gov budget codex daily off; gov budget codex off. Without arguments: the budgets.
        const [provider, window, value, unitArg] = rest;
        const usage = `usage: gov budget [PROVIDER (${Object.keys(COUNTED_WINDOWS).join("|")}) N tokens|turns | PROVIDER [WINDOW] off]`;
        // Removing a whole budget takes any name, so one saved under a typo can go.
        if (provider && window !== "off") {
          if (!window) throw new Error(usage);
          runner(provider);
          if (!Object.hasOwn(COUNTED_WINDOWS, window)) throw new Error(`unknown window ${window} (windows: ${Object.keys(COUNTED_WINDOWS).join(", ")})`);
        }
        const { settings } = await api.call("settings.get", {});
        if (!provider) {
          const rows = Object.entries(settings.budgets as Record<string, { unit: string; windows: Record<string, number> }>).filter(([, b]) => Object.keys(b.windows).length);
          if (!rows.length) console.log(dim("no budgets: Runners are held by their own usage reports only"));
          for (const [p, b] of rows) console.log(`${oneLine(p).padEnd(8)} ${Object.entries(b.windows).map(([w, n]) => `${n} ${oneLine(b.unit)} ${oneLine(w)}`).join(", ")}`);
          if (rows.length) console.log(dim(`${COUNTED_LABEL}: use outside GovernCode is not seen`));
          return 0;
        }
        let budgets = settings.budgets;
        if (window === "off") {
          budgets = { ...budgets }; delete budgets[provider];
        } else {
          const cap = value === "off" ? null : Number(value);
          const unit = unitArg ?? budgets[provider]?.unit;   // the budget's unit, once it has one
          if (cap !== null && (!Number.isInteger(cap) || cap < 1 || (unit !== "tokens" && unit !== "turns"))) throw new Error(usage);
          budgets = setBudget(budgets, provider, window as CountedWindow, cap, cap === null ? undefined : unit as "tokens" | "turns");
        }
        await api.call("settings.set", { ...settings, budgets });   // the whole object: set replaces it
        const b = budgets[provider];
        if (!b) { console.log(`${oneLine(provider)}: no budget`); return 0; }
        console.log(`${oneLine(provider)}: at most ${Object.entries(b.windows).map(([w, n]) => `${n} ${oneLine(b.unit)} ${oneLine(w)}`).join(", ")}, ${COUNTED_LABEL}`);
        console.log(dim("GovernCode cannot see use outside it (your own sessions, other apps), so set this below your real plan." +
          (b.unit === "tokens" ? " A Runner that does not report tokens holds a token budget until the window resets: count it in turns." : "")));
        return 0;
      }
      case "local": {
        // gov local 2 15: at most 2 local-model Specs at once, each stopped after 15 minutes.
        const [running, minutes] = rest.map(Number);
        if (!Number.isInteger(running) || running < 1 || running > 8 || !Number.isInteger(minutes) || minutes < 1 || minutes > 120) {
          throw new Error("usage: gov local N M   (at most N local Specs at once, 1-8; each stopped after M minutes, 1-120)");
        }
        const { settings } = await api.call("settings.get", {});
        await api.call("settings.set", { ...settings, local: { maxRunning: running, maxMinutes: minutes } });
        console.log(`local models: at most ${running} at once, ${minutes} min each`);
        return 0;
      }
      case "runner": {
        // gov runner codex --model gpt-5.5 --effort medium: the Runner's default model and effort.
        const provider = rest[0], flag = (f: string) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };
        const model = flag("--model"), effort = flag("--effort");
        if (!provider || !model || (effort !== undefined && !Effort.safeParse(effort).success)) throw new Error("usage: gov runner PROVIDER --model M [--effort low|medium|high|max]");
        runner(provider);
        const { settings } = await api.call("settings.get", {});
        await api.call("settings.set", { ...settings, runners: { ...settings.runners, [provider]: { model, effort: effort ?? null } } });
        console.log(`${provider}: defaults to ${[model || "default model", effort].filter((x): x is string => Boolean(x)).map(oneLine).join(" · ")}`);
        return 0;
      }
      case "level": {
        // gov level relaxed|balanced|strict: how often Gates ask. The sandbox is the same at every level.
        const level = rest[0];
        if (!["relaxed", "balanced", "strict"].includes(level)) throw new Error("usage: gov level relaxed|balanced|strict");
        const { settings } = await api.call("settings.get", {});
        await api.call("settings.set", { ...settings, gates: { ...settings.gates, level } });
        console.log(`Gates: ${level} (the sandbox applies the same at every level)`);
        return 0;
      }
      case "personal": {
        // gov personal claude|codex on|off: whether that Controller brings the user's own instructions.
        const [provider, state] = rest;
        if (!["claude", "codex"].includes(provider) || !["on", "off"].includes(state)) throw new Error("usage: gov personal claude|codex on|off");
        const { settings } = await api.call("settings.get", {});
        await api.call("settings.set", { ...settings, personal: { ...settings.personal, [provider]: state === "on" } });
        console.log(`${provider}: personal instructions ${state}`);
        return 0;
      }
      case "acp": {
        const usage = "usage: gov acp search [QUERY] [--refresh] [--json] | inspect ID [--platform P] [--kind binary|npx|uvx] [--refresh] [--json] | install ID [--kind binary|npx|uvx] [--fingerprint F] | installed [--json] | inspect-installed INSTALLATION_ID [--json] | cancel I-N";
        const action = rest[0];
        if (action === "inspect-installed") {
          if (rest.length !== 2 && !(rest.length === 3 && rest[2] === "--json")) throw new Error(usage);
          const params = Params["acp.installed.inspect"].safeParse({ id: rest[1] });
          if (!params.success) throw new Error(usage);
          const result: AcpStoredRuntimeObservation = await api.call("acp.installed.inspect", params.data);
          if (rest[2] === "--json") { console.log(jsonShown(JSON.stringify(result, null, 2))); return 0; }
          const { receipt, inspection } = result;
          const agentId = /^[a-z][a-z0-9-]*$/u.test(receipt.plan.agentId) ? receipt.plan.agentId : JSON.stringify(receipt.plan.agentId);
          console.log(`ACP stored runtime inspection · ${oneLine(receipt.installationId)}`);
          console.log(`Agent: ${oneLine(agentId)} ${oneLine(JSON.stringify(receipt.plan.version))} (registry-advertised) · ${oneLine(receipt.plan.platform)}`);
          console.log(`Artifact: SHA-256 ${oneLine(receipt.sha256)} · ${receipt.bytes} bytes`);
          console.log(`Catalog: ${oneLine(JSON.stringify(receipt.catalog.source))} · fetched ${oneLine(receipt.catalog.fetchedAt)} · SHA-256 ${oneLine(receipt.catalog.sha256)}`);
          console.log(`Installed: ${oneLine(receipt.installedAt)} · operation ${oneLine(receipt.operation)} · Gate ${oneLine(receipt.gate)}`);
          if (inspection.status === "observed") {
            console.log(`Observation: no PT_INTERP or PT_DYNAMIC in ${inspection.programHeaders} program headers of the supported bounded private ELF snapshot.`);
            console.log(`Layout: ${oneLine(inspection.format)} · ${oneLine(inspection.elfType)} · ${inspection.loadSegments} load segments`);
          } else {
            console.log(`Parser refusal: ${oneLine(inspection.reason)}${inspection.programHeaderIndex === null ? "" : ` · program header ${inspection.programHeaderIndex}`}`);
            console.log("The verified installation is retained; no supported-layout observation was produced.");
          }
          console.log("Read-only finite observation; runtime compatibility and Runner eligibility are not established.");
          return 0;
        }
        if (action === "installed") {
          if (rest.length > 2 || (rest.length === 2 && rest[1] !== "--json")) throw new Error(usage);
          const result = await api.call("acp.installed", {});
          if (rest[1] === "--json") console.log(jsonShown(JSON.stringify(result, null, 2)));
          else {
            for (const receipt of result.installations) console.log(`${oneLine(receipt.plan.agentId)} ${oneLine(receipt.plan.version)} · ${oneLine(receipt.installationId)} · ${receipt.bytes} bytes`);
            if (!result.installations.length) console.log(dim("no verified ACP artifacts stored"));
          }
          return 0;
        }
        if (action === "cancel") {
          if (rest.length !== 2 || !/^I-\d{1,16}$/.test(rest[1])) throw new Error(usage);
          console.log(`${oneLine((await api.call("acp.install.cancel", { id: rest[1] })).id)}: cancellation requested`);
          return 0;
        }
        if (action === "install") {
          if (!/^[a-z][a-z0-9-]{0,95}$/.test(rest[1] ?? "")) throw new Error(usage);
          const options: Record<string, string> = {};
          for (let i = 2; i < rest.length; i += 2) {
            if (!["--kind", "--fingerprint"].includes(rest[i]) || options[rest[i]] !== undefined || !rest[i + 1]) throw new Error(usage);
            options[rest[i]] = rest[i + 1];
          }
          const kind = options["--kind"] ?? "binary";
          if (!["binary", "npx", "uvx"].includes(kind) ||
              (options["--fingerprint"] !== undefined && !/^[a-f0-9]{64}$/.test(options["--fingerprint"]))) throw new Error(usage);
          return await installAcpInTerminal(api, rest[1], kind as "binary" | "npx" | "uvx", options["--fingerprint"]);
        }
        if (action !== "search" && action !== "inspect") throw new Error(usage);
        let value: string | undefined, json = false, refresh = false;
        const flags: Record<string, string> = {};
        for (let i = 1; i < rest.length; i++) {
          const word = rest[i];
          if (word === "--json" && !json) json = true;
          else if (word === "--refresh" && !refresh) refresh = true;
          else if (action === "inspect" && ["--platform", "--kind"].includes(word) && flags[word] === undefined
              && rest[i + 1] && !rest[i + 1].startsWith("--")) flags[word] = rest[++i];
          else if (!word.startsWith("--") && value === undefined) value = word;
          else throw new Error(usage);
        }
        const method = action === "search" ? "acp.search" : "acp.inspect";
        const params = action === "search" ? Params["acp.search"].safeParse({ query: value ?? "", refresh }) :
          Params["acp.inspect"].safeParse({ id: value, platform: flags["--platform"], kind: flags["--kind"], refresh });
        if (!params.success) throw new Error(usage);
        const result = await api.call(method, params.data);
        if (json) { console.log(jsonShown(JSON.stringify(result, null, 2))); return 0; }
        console.log(dim(`Official ACP catalog · fetched ${oneLine(result.catalog.fetchedAt)} · SHA-256 ${oneLine(result.catalog.sha256)}`));
        if (action === "search") {
          for (const agent of result.agents) console.log(`${oneLine(agent.id)} · ${oneLine(agent.name)} ${oneLine(agent.version)}\n  ${shown(agent.description)}`);
          console.log(dim(`${result.agents.length} matching agent(s) of ${result.total}. Inspect with gov acp inspect ID.`));
        } else {
          console.log(`${oneLine(result.agent.name)} (${oneLine(result.agent.id)}) ${oneLine(result.agent.version)} · ${oneLine(result.platform)}`);
          console.log(shown(result.agent.description));
          if (result.installation.supported) {
            const plan = result.installation.plan;
            console.log(`Distribution: ${oneLine(plan.kind)} · ${oneLine(plan.packageSpec ?? plan.version)}\nSource: ${oneLine(plan.source)}`);
            console.log(`Integrity: ${plan.checksum ? `SHA-256 ${oneLine(plan.checksum.value)}` : "exact package version"}`);
            console.log(`Advertised command: ${oneLine(JSON.stringify(plan.command))}`);
            if (result.fingerprint) console.log(`Review fingerprint: ${oneLine(result.fingerprint)}`);
            if (result.executor) console.log(`Storage: ${result.executor.supported ? "raw binary supported" : oneLine(result.executor.reason)}`);
          } else console.log(`Distribution unavailable: ${shown(result.installation.reason)}`);
          console.log("Runner eligibility:");
          for (const reason of result.eligibility.reasons) console.log(`  ${shown(reason)}`);
          console.log(dim("Read-only inspection. Stored artifacts remain ineligible for ACP Runner execution."));
        }
        return 0;
      }
      case "connect": {
        // gov connect: the tools and whether each is connected. gov connect TOOL: sign it in for
        // GovernCode with its own sign-in (a link to open, a code to paste back).
        const tool = rest[0];
        if (!tool) {
          const { tools } = await api.call("tools.list", { measure: true });
          for (const t of tools) {
            const use = t.usage?.readings?.length ? ` · ${t.usage.readings.map((r: any) => `${oneLine(r.window)} ${r.usedPercent}% used`).join(", ")}` : "";
            const state = !t.installed ? "not installed" : !t.connected ? `not connected (gov connect ${t.tool})`
              : t.problem ? `needs attention: ${t.problem}` : "connected" + use;
            console.log(`${oneLine(t.tool).padEnd(8)} ${oneLine(t.name).padEnd(12)} ${oneLine(state)}`);
          }
          return 0;
        }
        if (!["agy", "claude", "codex", "grok", "opencode"].includes(tool)) throw new Error("usage: gov connect [agy|claude|codex|grok|opencode]");
        // Codex: the browser hands the login back by itself; Grok: the code shown below is entered on the page. Nothing to paste here.
        const device = tool === "codex" || tool === "grok";
        const tty = answers();
        let id = "";
        api.onEvent(async (ev) => {
          if (ev.kind !== "connect") return;
          id = ev.id;
          if (ev.url && tool === "opencode") {
            // OpenCode signs in with the API key from its own page; typed without being shown.
            console.log(warn("\nOpen this link and copy your API key (GovernCode uses it for OpenCode Go and OpenCode's free models only):"));
            console.log(oneLine(ev.url));
            const hide = process.stdin.isTTY ? spawnSync("stty", ["-echo"], { stdio: "inherit" }).status === 0 : false;
            // However gov ends while the key is asked for (an error, Ctrl-C), the terminal shows typing again.
            const echo = () => { spawnSync("stty", ["echo"], { stdio: "inherit" }); };
            const interrupted = () => { echo(); process.exit(130); };
            if (hide) { process.once("exit", echo); process.once("SIGINT", interrupted); }
            let key: string | undefined;
            try { key = (await tty.next("\nPaste your OpenCode API key here (it is not shown): "))?.trim(); }
            finally { if (hide) { echo(); process.off("exit", echo); process.off("SIGINT", interrupted); process.stdout.write("\n"); } }
            await (key ? api.call("connect.input", { id, text: key }) : api.call("connect.cancel", { id })).catch((e: Error) => console.error(warn(oneLine(e.message))));
          } else if (ev.url && device) {
            console.log(warn(tool === "grok" ? "\nOpen this link, enter the code shown here and sign in; this finishes by itself when you are done:"
              : "\nOpen this link and sign in; this finishes by itself when you are done:"));
            console.log(oneLine(ev.url));
          } else if (ev.url) {
            console.log(warn("\nOpen this link and sign in:"));
            console.log(oneLine(ev.url));
            const code = (await tty.next("\nPaste the code it gives you here: "))?.trim();
            if (code) await api.call("connect.input", { id, text: code });
            else await api.call("connect.cancel", { id });
          } else if (ev.text && !PREAMBLE.test(ev.text)) console.log(dim(shown(ev.text)));
        });
        console.log(dim("Signing in inside GovernCode's sandbox, in a home that belongs to GovernCode (not your own setup)."));
        const r = await api.call("connect.start", { tool });
        tty.close();
        console.log(r.connected ? shown(r.note) : warn(shown(r.note)));
        return r.connected ? 0 : 1;
      }
      case "disconnect": {
        const tool = rest[0];
        if (!["agy", "claude", "codex", "grok", "opencode"].includes(tool)) throw new Error("usage: gov disconnect agy|claude|codex|grok|opencode");
        console.log(shown((await api.call("tools.disconnect", { tool })).note));
        return 0;
      }
      case "reset": {
        // gov reset: the Controller forgets this project's conversation (the Trace keeps it all).
        const project = await currentProject(api);
        await api.call("conversation.reset", { project });
        console.log(`new conversation${project ? ` in ${oneLine(project)}` : " at Home"}`);
        return 0;
      }
      case "spec-caps": {
        // gov spec-caps 3 2: at most 3 Specs running at once in a project, 2 for one Runner.
        const usage = "usage: gov spec-caps PER-PROJECT PER-RUNNER   (1-10 each, e.g. gov spec-caps 3 2)";
        const [a, b] = rest.map(Number);
        if (rest.length !== 2 || ![a, b].every((n) => Number.isInteger(n) && n >= 1 && n <= 10)) throw new Error(usage);
        const { settings } = await api.call("settings.get", {});
        if (!settings.specs) throw new Error("this govd runs one Spec at a time (update GovernCode)");
        await api.call("settings.set", { ...settings, specs: { maxPerProject: a, maxPerRunner: b } });
        console.log(`Specs at once: up to ${a} per project, ${b} per Runner`);
        return 0;
      }
      case "spec-models": {
        // gov spec-models free|within|defaults: how far a Controller may depart from the defaults per Spec.
        const policy = rest[0];
        if (!["free", "within", "defaults"].includes(policy)) throw new Error("usage: gov spec-models free|within|defaults");
        const { settings } = await api.call("settings.get", {});
        await api.call("settings.set", { ...settings, specModels: policy });
        console.log(`per-Spec models: ${policy}`);
        return 0;
      }
      case "reserve": {
        // gov reserve codex weekly 15: keep 15% of Codex's weekly window back (0 to 90).
        const [provider, window, value] = rest;
        const n = Number(value);
        if (!provider || !window || !value || !Number.isInteger(n) || n < 0 || n > 90) throw new Error("usage: gov reserve PROVIDER WINDOW PERCENT   (0-90, e.g. gov reserve codex weekly 15)");
        runner(provider);
        // (the window is govd's to check: it also knows the windows each Runner reports right now)
        const { settings } = await api.call("settings.get", {});
        const reserves = { ...settings.reserves, [provider]: { ...(settings.reserves[provider] ?? {}), [window]: n } };
        await api.call("settings.set", { ...settings, reserves });   // the whole object: set replaces it
        console.log(`${provider}: keeps ${n}% of its ${oneLine(window)} window back`);
        return 0;
      }
      case "limits": {
        const { providers } = await api.call("limits.list", { measure: true });
        if (!providers.length) console.log(dim("no measured Runners"));
        for (const x of providers) {
          const windows = x.readings.map((r: any) => `${oneLine(r.window)} ${r.counted ? `${r.counted.used}/${r.counted.cap} ${oneLine(r.counted.unit)}` : `${r.usedPercent}% used`}${r.resetsAt ? `, ${resetWhen(r.resetsAt)}` : ""}`).join("; ") || "not measured";
          const held = [x.reservedPercent ? `${x.reservedPercent}% reserved by running Specs` : "",
            x.owedPercent ? `${x.owedPercent}% held for finished Specs until the usage report catches up` : ""].filter(Boolean).join(", ");
          const rule = x.local ? `local: at most ${x.local.maxRunning} at once, ${x.local.maxMinutes} min each` : `${windows}  · keeps ${x.reservePercent}% back`;
          console.log(`${oneLine(x.provider).padEnd(8)} ${x.verdict.ok ? "available" : "held     "}  ${rule}${held ? ` · ${held}` : ""}${x.counted ? ` · ${oneLine(x.counted)}` : ""}${x.unmetered ? " · unmetered (your opt-in)" : ""}${x.verdict.ok ? "" : `  ${dim(oneLine(x.verdict.reason))}`}`);
        }
        return 0;
      }
      case "limited": {
        const { items } = await api.call("recovery.list", {});
        if (!items.length) console.log(dim("no limited Specs or turns"));
        const kind: Record<string, string> = { held: "held Spec", spec: "limited Spec", turn: "turn" };
        for (const x of items) {
          const reset = x.resetsAt === null ? "reset time unknown" : resetWhen(x.resetsAt);
          console.log(`${oneLine(x.target)}  ${oneLine(kind[x.kind] ?? x.kind).padEnd(12)} ${oneLine(x.provider).padEnd(8)} ${reset} · at reset: ${x.atReset ? "on" : "off"}${x.note ? ` · ${oneLine(x.note)}` : ""}`);
        }
        return 0;
      }
      case "resume": {
        const [id, flag] = rest;
        const usage = "usage: gov resume ID [--at-reset|--off|--clear]";
        if (!/^(S-\d{4,}|T-\d+)$/.test(id ?? "") || rest.length > 2 || (flag !== undefined && !["--at-reset", "--off", "--clear"].includes(flag))) throw new Error(usage);
        const listed = await api.call("recovery.list", {});
        const item = listed.items?.find((x: any) => x.target === id);
        if (!item) throw new Error(`${id} is not limited`);
        if (flag === "--clear") {
          await api.call("recovery.clear", { target: id, since: item.since });
          console.log(`${id}: cleared`);
          return 0;
        }
        if (flag) {
          const atReset = flag === "--at-reset";
          await api.call("recovery.set", { target: id, since: item.since, atReset });
          console.log(`${id}: at reset ${atReset ? "on" : "off"}`);
          return 0;
        }
        if (id.startsWith("S-")) {
          const r = await api.call("recovery.resume", { id, since: item.since });
          const note = r.note ?? r.reason;
          console.log(`${oneLine(r.id)}: ${oneLine(r.status)}${note ? ` · ${oneLine(note)}` : ""}`);
          return 0;
        }
        const tty = answers();
        const r = await runAsk(api, item.project, "Continue where you left off.", tty, { continuationOf: id });
        tty.close();
        console.log(dim(r.ok ? "— done" : `— failed: ${shown(r.summary)}`));
        return r.ok ? 0 : 1;
      }
      case "specs": {
        const project = await currentProject(api);
        const { specs } = await api.call("spec.list", { project: project ?? undefined });
        if (!specs.length) console.log(dim("no Specs yet"));
        // An empty model is the Runner's default; an effort is shown only when the Spec set one.
        const used = (x: any) => [x.model || "default model", x.effort].filter((x): x is string => Boolean(x)).map(oneLine).join(" · ");
        const width = Math.max(20, ...specs.map((x: any) => used(x).length));
        for (const x of specs) console.log(`${oneLine(x.id)}  ${oneLine(x.to).padEnd(8)} ${used(x).padEnd(width)} ${oneLine(x.status).padEnd(13)} ${String(x.files.length).padStart(3)} files  ${dim(oneLine(x.brief.slice(0, 50)))}`);
        return 0;
      }
      case "diff": {
        if (!/^S-\d{4,}$/.test(rest[0] ?? "")) throw new Error("usage: gov diff S-NNNN (see gov specs)");
        const r = await api.call("spec.diff", { id: rest[0] });
        const checkpoints = SpecCheckpoints.safeParse(r.checkpoints);
        if (checkpoints.success) console.log(`${rest[0]}: ${checkpoints.data.before} → ${checkpoints.data.after}`);
        console.log(r.diff ? shown(r.diff) : dim("(no changes)"));
        if (r.diff) hiddenNote(r.diff);
        return 0;
      }
      case "accept": {
        if (!/^S-\d{4,}$/.test(rest[0] ?? "")) throw new Error("usage: gov accept S-NNNN (see gov specs)");
        const id = rest[0];
        const usage = "usage: gov accept S-NNNN [--before OID --after OID] (full reviewed Git object IDs)";
        let explicit: SpecCheckpoints | undefined;
        if (rest.length > 1) {
          const flags: Record<string, string> = {};
          if (rest.length !== 5) throw new Error(usage);
          for (let i = 1; i < rest.length; i += 2) {
            if (!["--before", "--after"].includes(rest[i]) || flags[rest[i]] !== undefined) throw new Error(usage);
            flags[rest[i]] = rest[i + 1];
          }
          const checked = SpecCheckpoints.safeParse({ before: flags["--before"], after: flags["--after"] });
          if (!checked.success) throw new Error(usage);
          explicit = checked.data;
        }
        const reviewed = SpecDiff.safeParse(await api.call("spec.diff", { id }));
        const bound = reviewed.success ? SpecCheckpoints.safeParse(reviewed.data.checkpoints) : null;
        if (!reviewed.success || !bound?.success) throw new Error("govd returned no valid review checkpoints; not accepted (update GovernCode or wait for the Spec to finish)");
        const checkpoints = bound.data;
        console.log(`${id}: ${checkpoints.before} → ${checkpoints.after}`);
        console.log(reviewed.data.diff ? shown(reviewed.data.diff) : dim("(no changes)"));
        if (reviewed.data.diff) hiddenNote(reviewed.data.diff);
        if (explicit) {
          if (explicit.before !== checkpoints.before || explicit.after !== checkpoints.after) throw new Error("the explicit snapshots do not match this diff; not accepted (review it again)");
        } else {
          const tty = answers();
          let a: string | undefined;
          try { a = (await tty.next(`Apply ${id}'s displayed changes? [y/N] `))?.trim().toLowerCase(); }
          finally { tty.close(); }
          if (a === undefined) throw new Error("no confirmation here: not accepted; review in a terminal, or pass --before OID --after OID for snapshots you already reviewed");
          if (a !== "y" && a !== "yes") { console.log(`${id}: not accepted`); return 0; }
        }
        const r = await api.call("spec.accept", { id, checkpoints });
        console.log(`${oneLine(r.id)}: applied ${r.applied.length} file(s) to the project: ${r.applied.map(oneLine).join(", ")}`);
        return 0;
      }
      case "cancel": {
        // gov cancel S-0003: stop a running Spec; what it changed so far stays for review.
        if (!/^S-\d{4,}$/.test(rest[0] ?? "")) throw new Error("usage: gov cancel S-NNNN (see gov specs)");
        const r = await api.call("spec.cancel", { id: rest[0] });
        console.log(r.status === "running" ? `${oneLine(r.id)}: asked to stop; it has not ended yet (gov specs shows when it has)`
          : r.files.length ? `${oneLine(r.id)}: cancelled; ${r.files.length} changed file(s) kept for review (possibly incomplete): gov diff ${oneLine(r.id)}`
          : `${oneLine(r.id)}: cancelled before it changed anything`);
        return 0;
      }
      case "discard": {
        if (!/^S-\d{4,}$/.test(rest[0] ?? "")) throw new Error("usage: gov discard S-NNNN (see gov specs)");
        await api.call("spec.discard", { id: rest[0] });
        console.log(`${rest[0]}: discarded`);
        return 0;
      }
      case "trace": {
        const project = await currentProject(api);
        // gov trace --jsonl: every event of this project (or all), oldest first, one JSON object per
        // line, for export. Read a page at a time; an older govd ignores `after` and repeats its newest
        // page, which ends it rather than looping.
        if (rest.includes("--jsonl")) {
          // A page is written only as fast as the reader takes it, and a reader that has gone (| head)
          // ends the export: the whole Trace is never queued in memory.
          let gone = false;
          process.stdout.on("error", () => { gone = true; });
          for (let after = 0; !gone;) {
            const page = (await api.call("trace.list", { project: project ?? undefined, limit: 1000, after })).events.filter((e: any) => e.seq > after);
            for (const e of page) {
              if (gone) break;
              if (!process.stdout.write(jsonShown(JSON.stringify(e)) + "\n")) await new Promise((ok) => { process.stdout.once("drain", ok); process.stdout.once("error", ok); });
            }
            if (page.length < 1000) return 0;
            after = page.at(-1).seq;
          }
          return 0;
        }
        const { events } = await api.call("trace.list", { project: project ?? undefined, limit: 50 });
        for (const e of events) console.log(`${new Date(e.ts).toTimeString().slice(0, 8)}  ${oneLine(e.kind).padEnd(16)} ${oneLine(e.project ?? "-").padEnd(12)} ${dim(oneLine(e.actor))}`);
        return 0;
      }
      case "friction": {
        // gov friction [--project NAME] [--days N] [--json]: Gates, failed turns and refusals, read
        // from the Trace. It changes nothing.
        const usage = "usage: gov friction [--project NAME] [--days N] [--json]";
        let project: string | undefined, days = 7, json = false;
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === "--json" && !json) json = true;
          else if (rest[i] === "--project" && project === undefined && rest[i + 1] !== undefined) project = projectName(rest[++i]);
          else if (rest[i] === "--days" && /^\d{1,4}$/.test(rest[i + 1] ?? "") && +rest[i + 1] >= 1 && +rest[i + 1] <= 3650) days = +rest[++i];
          else throw new Error(usage);
        }
        const since = new Date(Date.now() - days * 86_400_000);
        const events = await readTrace(async (after, limit) => (await api.call("trace.list", { project, limit, ...(after === undefined ? {} : { after }) })).events,
          since, (e) => FRICTION_KINDS.has(e.kind));
        const report = friction(events, { since, project });
        if (json) console.log(jsonShown(JSON.stringify(report, null, 2)));
        else printFriction(report, days);
        return 0;
      }
      case "ask": {
        const prompt = rest.join(" ");
        if (!prompt.trim()) throw new Error('usage: gov ask "PROMPT"');
        const project = await currentProject(api);
        const tty = answers();
        const r = await runAsk(api, project, prompt, tty);
        tty.close();
        console.log(dim(r.ok ? "— done" : `— failed: ${shown(r.summary)}`));
        return r.ok ? 0 : 1;
      }
      case "demo": {
        const i = rest.indexOf("--path");
        const tty = answers();
        try { return await runDemo(api, { path: i >= 0 ? rest[i + 1] : undefined, tty, runAsk, dim, warn }); }
        finally { tty.close(); }
      }
      default:
        console.error(USAGE);
        return 2;
    }
  };
  try { return await Promise.race([api.eventFailure, command()]); }
  finally {
    api.sock.end();
  }
}

// Exit once stdout has flushed: into a pipe its writes queue, and exiting at once cut off whatever a
// slow reader (| less, | jq) had not taken yet.
const exit = (code: number) => process.stdout.write("", () => process.exit(code));
main(process.argv.slice(2)).then(exit, (err) => { console.error(`gov: ${oneLine(err.message)}`); exit(1); });

/** Said after a diff, before anything is applied: characters a file can carry that a terminal draws
 *  as nothing (or that move text) are in it, shown as codes above. Read those lines closely. */
function hiddenNote(diff: string): void {
  const n = hiddenCount(diff);
  if (n) console.log(warn(`This diff holds ${n} hidden or control character${n === 1 ? "" : "s"}, shown above as codes (\\u2028, \\x1b...). Read those lines closely: they can change what code does without showing it.`));
}

/** gov friction's report, short and aligned. */
function printFriction(r: FrictionReport, days: number): void {
  const counts = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${n} ${oneLine(k)}`).join(", ");
  const why = (m: Record<string, number>) => (Object.keys(m).length ? ` (${counts(m)})` : "");
  const limited = (n: number) => (n ? ` (${n} at a usage limit)` : "");
  const { turns: t, gates: g, sandbox: s, specs } = r;
  console.log(`Friction in the last ${days} day${days === 1 ? "" : "s"}, ${oneLine(r.project ?? "all projects")} ${dim("(read from the Trace; nothing is changed)")}`);
  console.log(`Turns    ${t.started} started · ${t.completed} completed · ${t.failed} failed${limited(t.limited)}`);
  console.log(`Gates    ${g.opened} opened (${g.byControllers} by Controllers, ${g.byRunners} by Runners)${g.perTurn === null ? "" : ` · ${g.perTurn.toFixed(1)} per Controller turn`}`);
  console.log(`         ${g.allowed} allowed by you · ${g.denied} denied by you · ${g.autoDenied} denied by govd${why(g.autoDeniedBy)}`);
  console.log(`         ${g.passed} let through without a Gate${why(g.passedBy)}`);
  console.log(`Sandbox  ${s.refused} turn${s.refused === 1 ? "" : "s"} refused${why(s.refusedBy)} · .git restored ${s.gitScrubbed} time${s.gitScrubbed === 1 ? "" : "s"} · .git guard failed ${s.gitGuardFailed} time${s.gitGuardFailed === 1 ? "" : "s"}`);
  if (s.blocked) console.log(`         ${s.blocked} step${s.blocked === 1 ? "" : "s"} probably blocked by the sandbox${why(s.blockedBy)}`);
  console.log(`Specs    ${specs.created} created · ${specs.failed} failed${limited(specs.limited)} · ${specs.held} held`);
  // Steps a rule or plan let through have kinds but no tool row: either table can stand alone.
  if (!r.tools.length && !r.kinds.length) return;
  // Keep the full labels: truncation could hide a control or the end of a command.
  if (r.tools.length) {
    const w = Math.min(40, Math.max(4, ...r.tools.map((x) => oneLine(x.tool).length)));
    console.log(`\n${"Tool".padEnd(w)}  asked  allowed  denied  by govd`);
    for (const x of r.tools) {
      console.log(`${oneLine(x.tool).padEnd(w)}  ${String(x.asked).padStart(5)}  ${String(x.allowed).padStart(7)}  ${String(x.denied).padStart(6)}  ${String(x.autoDenied).padStart(7)}${x.allowedEveryTime ? "  allowed every time" : ""}`);
    }
  }
  if (r.kinds.length) {
    const k = Math.min(48, Math.max(12, ...r.kinds.map((x) => kindName(oneLine(x.kind)).length)));
    const blockedCol = r.kinds.some((x) => x.blocked);   // shown only once a step probably ran into the sandbox
    console.log(`\n${"Kind of step".padEnd(k)}  asked  allowed  denied  by govd  let through${blockedCol ? "  blocked*" : ""}`);
    for (const x of r.kinds) {
      const name = kindName(oneLine(x.kind));   // a name past the column's cap is shortened, so the columns stay in line
      console.log(`${(name.length > k ? `${name.slice(0, k - 1)}…` : name).padEnd(k)}  ${String(x.asked).padStart(5)}  ${String(x.allowed).padStart(7)}  ${String(x.denied).padStart(6)}  ${String(x.autoDenied).padStart(7)}  ${String(x.passed).padStart(11)}${blockedCol ? `  ${String(x.blocked).padStart(8)}` : ""}${x.allowedEveryTime ? "  allowed every time" : ""}`);
    }
    if (blockedCol) console.log(dim("*blocked: steps that failed saying what the sandbox says when it refuses something; probably the sandbox, an estimate."));
  }
  const older = g.opened - r.kindsRecorded;
  if (r.kinds.length) console.log(dim("A command of several kinds counts under each. Let through: by your rules, an approved plan or relaxed Gates."));
  if (older > 0) console.log(dim(`${older} Gate${older === 1 ? "" : "s"} from an older govd recorded only the tool, not the kind.`));
  console.log(dim("Allowed every time: 5 or more, never denied by you; a candidate for a standing allow. No rule was made."));
}

async function daemon(verb: string | undefined): Promise<number> {
  const svc = await import("./service.ts");
  switch (verb) {
    case "install": console.log(`installed ${oneLine(svc.install())} and started governcode.service`); return 0;
    case "uninstall": svc.uninstall(); console.log("stopped and disabled governcode.service"); return 0;
    case "start": {
      const state = stateDir(env);
      console.log(`govd started (pid ${svc.startOnce(state)}); log: ${oneLine(join(state, "govd.log"))}`);
      return 0;
    }
    default: console.error("usage: gov daemon start|install|uninstall"); return 2;
  }
}
