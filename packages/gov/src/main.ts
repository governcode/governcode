#!/usr/bin/env node
// gov: the command line. A thin client of govd over its Unix socket. Gates are answered here,
// in the user's own terminal, which the sandboxed harness has no way to reach.
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { COUNTED_LABEL, COUNTED_WINDOWS, setBudget, type CountedWindow } from "@governcode/protocol";
import { runDemo } from "./demo.ts";
import { checkHost, localSocket, stateDir, tunnelSocket } from "./tunnel.ts";

const env = process.env;
// The local govd's socket, or with `gov --host HOST ...` the one `gov tunnel HOST` forwards.
let socketPath = localSocket(env);
let host: string | null = null;

type Reply = { result?: any; error?: { code: number; message: string } };

function open(): Promise<{ call(method: string, params?: unknown): Promise<any>; onEvent(f: (e: any) => void): void; sock: Socket }> {
  return new Promise((ok, fail) => {
    const sock = connect(socketPath);
    let next = 1;
    const waiting = new Map<number, (r: Reply) => void>();
    let listener: (e: any) => void = () => {};
    sock.once("error", () => fail(new Error(host ? `no tunnel to ${host} (no socket at ${socketPath}). Open one with: gov tunnel ${host}`
      : `govd is not running (no socket at ${socketPath}). Start it with: npm run govd`)));
    const lines = createInterface({ input: sock });
    lines.on("error", () => {});   // the socket's own error handler reports it
    lines.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.method === "event") return listener(msg.params);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    });
    sock.once("connect", () => ok({
      sock,
      onEvent: (f) => (listener = f),
      call: (method, params = {}) => new Promise((res, rej) => {
        const id = next++;
        waiting.set(id, (r) => (r.error ? rej(new Error(r.error.message)) : res(r.result)));
        sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      }),
    }));
  });
}

/** Answers typed (or piped) by the user, one line each; end of input means "no". */
function answers(): { next(prompt: string): Promise<string>; close(): void } {
  const lines: string[] = [];
  const waiting: Array<(l: string) => void> = [];
  let ended = false;
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (l) => (waiting.length ? waiting.shift()!(l) : lines.push(l)));
  rl.on("close", () => { ended = true; while (waiting.length) waiting.shift()!(""); });
  return {
    next: (prompt) => {
      process.stdout.write(prompt);
      if (lines.length) return Promise.resolve(lines.shift()!);
      if (ended) return Promise.resolve("");
      return new Promise((ok) => waiting.push(ok));
    },
    close: () => rl.close(),
  };
}

const PROVIDER_NAMES: Record<string, string> = { "claude-code": "Claude Code (Anthropic)", codex: "Codex (OpenAI)" };
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const warn = (s: string) => `\x1b[33m${s}\x1b[0m`;

/** The first time a Controller works, ask once whether the user's own instructions come along
 *  (off by default; said plainly both ways). */
async function askPersonal(api: Awaited<ReturnType<typeof open>>, project: string | null, tty: ReturnType<typeof answers>): Promise<void> {
  const { settings } = await api.call("settings.get", {});
  const { projects } = await api.call("project.list", {});
  const provider = projects.find((p: any) => p.name === project)?.controller.provider === "codex" ? "codex" : "claude";
  if (settings.personal?.[provider] !== null) return;
  const tool = provider === "codex" ? "Codex" : "Claude Code";
  const files = provider === "codex" ? "your AGENTS.md" : "your CLAUDE.md, skills, agents, commands, plugins and hooks";
  console.log(warn(`\nUse your own ${tool} instructions in GovernCode?`));
  console.log(`  No (the default): ${tool} starts clean, from its own defaults and GovernCode's instructions only.`);
  console.log(`  Yes: it reads ${files}, as it does outside GovernCode, so what you have built up comes along.`);
  console.log(dim("  The sandbox and Gates apply the same either way. Change it later: gov personal " + provider + " on|off"));
  const a = (await tty.next("Use your own instructions? [y/N] ")).trim().toLowerCase();
  await api.call("settings.set", { ...settings, personal: { ...settings.personal, [provider]: a === "y" || a === "yes" } });
}

/** One Controller turn in the terminal: text streams, Gates ask (with standing-allow choices). */
export async function runAsk(api: Awaited<ReturnType<typeof open>>, project: string | null, prompt: string,
    tty: ReturnType<typeof answers>): Promise<{ ok: boolean; summary: string }> {
  await askPersonal(api, project, tty);
  api.onEvent(async (ev) => {
    if (ev.kind === "text") process.stdout.write(ev.text + "\n");
    else if (ev.kind === "tool") console.log(dim(`· ${ev.name}`));
    else if (ev.kind === "spec") console.log(warn(`\n${ev.id} → Runner · ${ev.to}: ${ev.brief}`));
    else if (ev.kind === "spec.text") console.log(dim(`  ${ev.id} · ${ev.text.slice(0, 200)}`));
    else if (ev.kind === "spec.tool") console.log(dim(`  ${ev.id} · ${ev.name}`));
    else if (ev.kind === "gate") {
      const runner = /\(Runner · ([^,]+), (S-\d+)\)$/.exec(String(ev.tool));
      console.log(warn(runner ? `\nGate: Runner ${runner[1]} (${runner[2]}) wants to use ${String(ev.tool).replace(runner[0], "").trim()}. Exactly this will run:`
                              : `\nGate: the Controller wants to use ${ev.tool}. Exactly this will run:`));
      console.log(ev.canonical);
      // Standing allows skip the question for this kind of step; the sandbox still applies.
      const scopes: string[] = ev.scopes ?? [];
      const keys: Record<string, string> = { turn: "t", spec: "s", project: "p" };
      if (scopes.length) console.log(dim(`  Also allow ${ev.covers} for: ${scopes.map((s) => `[${keys[s]}] this ${s}`).join(", ")}.` +
        " That only skips this question; the sandbox still applies to every step."));
      if (ev.suggest) console.log(dim(`  Suggested: [${keys[ev.suggest]}], so this kind of step stops asking in this ${ev.suggest}.`));
      const choices = ["y", ...scopes.map((s) => keys[s])].join("/");
      const a = (await tty.next(`Allow? [${choices}/N] `)).trim().toLowerCase();
      if (!a) console.log("");
      const remember = scopes.find((s) => keys[s] === a);
      await api.call("gate.answer", { id: ev.id, answer: a === "y" || a === "yes" || remember ? "allow" : "deny", ...(remember ? { remember } : {}) });
    } else if (ev.kind === "allowed") {
      console.log(dim(`· allowed without asking: ${ev.why} (the sandbox still applies)`));
    } else if (ev.kind === "plan") {
      console.log(warn(`\nGame plan ${ev.id}: who does what`));
      ev.items.forEach((it: any, i: number) => console.log(`  ${i + 1}. ${it.who === "me" ? "Controller" : it.who}: ${it.what}${it.scope?.length ? dim(` (${it.scope.join(", ")})`) : ""}`));
      if (ev.note) console.log(dim(`  ${ev.note}`));
      console.log(dim(ev.handoff === "plan" ? "  Each approved handoff runs once without asking again; anything else still asks." : "  Handoffs still ask at a Gate (Crew card: ask each time)."));
      const a = (await tty.next("Approve? [y = all / 1,3 = only those / j = just you / N] ")).trim().toLowerCase();
      const nums = /^\d+(\s*,\s*\d+)*$/.test(a) ? a.split(",").map((x) => Number(x.trim())) : null;
      await api.call("plan.answer", { id: ev.id, ...(a === "y" || a === "yes" ? { answer: "approve" } : nums ? { answer: "approve", items: nums } : a === "j" ? { answer: "just-you" } : { answer: "reject" }) });
    } else if (ev.kind === "proposal") {
      console.log(warn(`\nThe Controller proposes a new project: ${ev.name} at ${ev.path}${ev.git ? " (git init, branch main)" : ""}`));
      if (ev.reason) console.log(dim(ev.reason));
      const a = (await tty.next("Create it? [y/N] ")).trim().toLowerCase();
      const r = await api.call("proposal.answer", { id: ev.id, answer: a === "y" || a === "yes" ? "create" : "cancel" });
      console.log(dim(r.created ? `created ${r.created.name} · gov open ${r.created.path}` : "not created"));
    }
  });
  return await api.call("ask", { project, prompt });
}

async function currentProject(api: Awaited<ReturnType<typeof open>>): Promise<string | null> {
  const here = resolve(process.cwd());
  const { projects } = await api.call("project.list");
  const match = projects.filter((p: any) => here === p.path || here.startsWith(p.path + "/")).sort((a: any, b: any) => b.path.length - a.path.length)[0];
  return match?.name ?? null;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "--host") {
    host = checkHost(argv[1]);
    socketPath = tunnelSocket(host, env);
    argv = argv.slice(2);
  }
  const [cmd, ...rest] = argv;
  if (cmd === "daemon") return daemon(rest[0]);
  if (cmd === "socket-path") { console.log(socketPath); return 0; }
  if (cmd === "tunnel") {
    // gov tunnel HOST [--remote-socket PATH] | gov tunnel --stop HOST | gov tunnel (the open ones)
    const t = await import("./tunnel.ts");
    if (host) throw new Error("gov tunnel takes the host itself: gov tunnel HOST");
    if (rest[0] === "--stop") { console.log(t.stopTunnel(rest[1], env)); return 0; }
    if (!rest.length) { const rows = t.listTunnels(env); console.log(rows.length ? rows.join("\n") : dim("no tunnels (gov tunnel HOST opens one)")); return 0; }
    const i = rest.indexOf("--remote-socket");
    if (rest.length !== (i >= 0 ? 3 : 1) || (i >= 0 && i !== 1)) throw new Error("usage: gov tunnel HOST [--remote-socket PATH] | gov tunnel --stop HOST | gov tunnel");
    return t.runTunnel(rest[0], i >= 0 ? rest[i + 1] : undefined, env);
  }
  const api = await open();
  try {
    switch (cmd) {
      case undefined:
      case "status": {
        const h = await api.call("hello", { client: "gov", protocol: 1 });
        const project = await currentProject(api);
        console.log(`govd ${h.version} · protocol ${h.protocol} · sandbox: ${h.sandbox.ok ? "enforced (self-test passed)" : warn("NOT verified: " + h.sandbox.reason)}`);
        console.log(project ? `project: ${project}` : dim("no project here (Home). gov open PATH or gov new NAME"));
        return 0;
      }
      case "projects": {
        const { projects } = await api.call("project.list");
        for (const p of projects) console.log(`${p.name.padEnd(14)} ${p.path}  ${dim(`${p.controller.provider} · ${p.controller.model} · ${p.controller.effort ?? "n/a"}`)}`);
        if (!projects.length) console.log(dim("no projects yet"));
        return 0;
      }
      case "new": {
        const name = rest[0];
        const at = rest.indexOf("--path");
        const path = at >= 0 ? rest[at + 1] : join(process.cwd(), name ?? "");
        const { project } = await api.call("project.new", { name, path, git: !rest.includes("--no-git") });
        console.log(`created ${project.name} at ${project.path}`);
        return 0;
      }
      case "open": {
        const path = resolve(rest[0] ?? ".");
        const { project } = await api.call("project.open", { path, name: rest[1] });
        console.log(`opened ${project.name} (${project.path})`);
        return 0;
      }
      case "controller": {
        const project = await currentProject(api);
        if (!project) throw new Error("run this inside a project folder");
        const m = rest.indexOf("--model"), e = rest.indexOf("--effort");
        const provider = rest[0] ?? "claude-code";
        // Project memory goes to another provider only if the user says so, once per project.
        const ctx = await api.call("context.state", { project });
        if (ctx.providers.some((x: string) => x !== provider) && ctx.shared[provider] === undefined) {
          const tty = answers();
          const who = PROVIDER_NAMES[provider] ?? provider;
          console.log(warn(`\n${who} will see this project's conversation, its record (${ctx.specs} Specs, ${ctx.checkpoints} Checkpoints) and its notes${ctx.notes ? ":" : " (none yet)."}`));
          if (ctx.notes) console.log(dim(ctx.notes.split("\n").slice(0, 8).map((l: string) => "  " + l).join("\n") + (ctx.notes.split("\n").length > 8 ? "\n  …" : "")));
          console.log(dim("  Yes: it picks up where the last Controller left off. No: it starts fresh here, with only its own turns."));
          const a = (await tty.next("Share this project's context with it? [y/N] ")).trim().toLowerCase();
          tty.close();
          await api.call("context.share", { project, provider, share: a === "y" || a === "yes" });
        }
        await api.call("controller.set", { project, controller: { provider,
          model: m >= 0 ? rest[m + 1] : "opus", effort: e >= 0 ? rest[e + 1] : "high" } });
        console.log(`Controller for ${project}: ${rest[0] ?? "claude-code"}`);
        return 0;
      }
      case "crew": {
        // gov crew: this project's Crew card. Set a part: works on|off, handoff ask|plan|off,
        // runners all|codex,agy, max RUNNER N|none, subagents controller|runners on|off.
        const project = await currentProject(api);
        if (!project) throw new Error("run this inside a project folder");
        const { crew } = await api.call("crew.get", { project });
        const [what, a, b] = rest;
        const usage = "usage: gov crew [works on|off | handoff ask|plan|off | runners all|R1,R2 | max RUNNER N|none | subagents controller|runners on|off]";
        if (what) {
          if (what === "works" && ["on", "off"].includes(a)) crew.controllerWorks = a === "on";
          else if (what === "handoff" && ["ask", "plan", "off"].includes(a)) crew.handoff = a;
          else if (what === "runners" && a) crew.runners = a === "all" ? null : a.split(",").map((x: string) => x.trim()).filter(Boolean);
          else if (what === "max" && a && b === "none") delete crew.maxPercent[a];
          else if (what === "max" && a && Number.isInteger(Number(b))) crew.maxPercent[a] = Number(b);
          else if (what === "subagents" && ["controller", "runners"].includes(a) && ["on", "off"].includes(b)) crew.subagents[a] = b === "on";
          else throw new Error(usage);
          await api.call("crew.set", { project, crew });
        }
        const HANDOFF: Record<string, string> = { ask: "ask me each time", plan: "follow the approved plan", off: "off (the Controller works alone)" };
        console.log(`Crew card for ${project}`);
        console.log(`  Controller     ${crew.controllerWorks ? "works itself and hands off" : "plans and hands off only (the project is read-only for it)"}`);
        console.log(`  Handing off    ${HANDOFF[crew.handoff]}`);
        console.log(`  Runners        ${crew.runners ? crew.runners.join(", ") || "none" : "all connected Runners"}`);
        const caps = Object.entries(crew.maxPercent).map(([r, n]) => `${r} ${n}%`).join(", ");
        console.log(`  Most per Spec  ${caps || "the Runner's Limit (25% at most)"}`);
        console.log(`  Subagents      Controller ${crew.subagents.controller ? "on" : "off"} · Runners ${crew.subagents.runners ? "on" : "off"}`);
        if (!what) console.log(dim(usage));
        return 0;
      }
      case "notes": {
        // gov notes: this project's notes; edit (in $EDITOR), history, restore SEQ.
        const project = await currentProject(api);
        if (!project) throw new Error("run this inside a project folder");
        const n = await api.call("notes.get", { project, limit: rest[0] === "restore" ? 1000 : 50 });
        if (!rest[0]) { console.log(n.text || dim("no notes yet (the Controller writes them with project_notes; gov notes edit to write your own)")); return 0; }
        if (rest[0] === "history") {
          for (const h of n.history) console.log(`${String(h.seq).padStart(6)}  ${new Date(h.ts).toTimeString().slice(0, 8)}  ${h.actor.padEnd(22)} ${h.text.length} chars`);
          return 0;
        }
        if (rest[0] === "restore") {
          const v = n.history.find((h: any) => String(h.seq) === rest[1]);
          if (!v) throw new Error("usage: gov notes restore SEQ   (see gov notes history)");
          await api.call("notes.set", { project, text: v.text });
          console.log(`notes restored to version ${v.seq}`);
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
          console.log(warn(`${g.id}  ${g.project ?? "Home"} · ${g.tool} · opened ${new Date(g.opened).toTimeString().slice(0, 8)}`));
          console.log(g.canonical);
        }
        return 0;
      }
      case "gate": {
        const [id, answer, flag] = rest;
        const remember = flag === "--turn" ? "turn" : flag === "--spec" ? "spec" : flag === "--project" ? "project" : undefined;
        if (!id || (answer !== "allow" && answer !== "deny") || (flag && !remember)) throw new Error("usage: gov gate G-N allow|deny [--turn|--spec|--project]");
        await api.call("gate.answer", { id, answer, ...(remember ? { remember } : {}) });
        console.log(`${id}: ${answer === "deny" ? "denied" : remember ? `allowed, and this kind of step for the rest of this ${remember} (the sandbox still applies)` : "allowed once"}`);
        return 0;
      }
      case "allows": {
        // gov allows [revoke R-N]: the standing allows remembered for projects.
        if (rest[0] === "revoke") {
          await api.call("allows.revoke", { id: rest[1] });
          console.log(`${rest[1]} revoked: that kind of step asks again`);
          return 0;
        }
        const project = await currentProject(api);
        const { rules } = await api.call("allows.list", project ? { project } : {});
        if (!rules.length) console.log(dim("no standing allows remembered for projects"));
        for (const r of rules) console.log(`${r.id}  ${(r.project ?? "").padEnd(14)} ${r.label}`);
        if (rules.length) console.log(dim("These only skip the question. The sandbox still applies to every step. Revoke with gov allows revoke R-N."));
        return 0;
      }
      case "turns": {
        const project = await currentProject(api);
        if (!project) throw new Error("run this inside a project folder");
        const { turns } = await api.call("turn.list", { project });
        if (!turns.length) console.log(dim("no Checkpoints yet (a turn that changed nothing records none)"));
        for (const t of turns) console.log(`${t.id.padEnd(8)} ${new Date(t.at).toTimeString().slice(0, 8)}  ${t.files.length} file(s)  ${dim(t.files.slice(0, 4).join(", "))}`);
        return 0;
      }
      case "undo": {
        const r = await api.call("turn.undo", { id: rest[0] });
        console.log(`${r.id}: restored ${r.restored.length} file(s): ${r.restored.join(", ")}`);
        return 0;
      }
      case "settings": {
        const { settings } = await api.call("settings.get", {});
        const rows = Object.entries(settings.reserves as Record<string, Record<string, number>>);
        if (!rows.length) console.log(dim("defaults: every Runner keeps 10% of each usage window back"));
        for (const [provider, windows] of rows) console.log(`${provider.padEnd(8)} ${Object.entries(windows).map(([w, n]) => `${w} ${n}%`).join(", ")}`);
        for (const [provider, d] of Object.entries(settings.runners as Record<string, { model: string; effort: string | null }>)) console.log(`${provider.padEnd(8)} defaults to ${d.model} · ${d.effort ?? "n/a"}`);
        console.log(`per-Spec models: ${settings.specModels}`);
        for (const [provider, b] of Object.entries(settings.budgets as Record<string, { unit: string; windows: Record<string, number> }>)) {
          if (!Object.keys(b.windows).length) continue;
          console.log(`${provider.padEnd(8)} budget ${Object.entries(b.windows).map(([w, n]) => `${n} ${b.unit} ${w}`).join(", ")} ${dim(`(${COUNTED_LABEL})`)}`);
        }
        console.log(`local models: at most ${settings.local.maxRunning} at once, ${settings.local.maxMinutes} min each`);
        return 0;
      }
      case "budget": {
        // gov budget codex daily 20 turns: at most 20 Runner turns a day, counted by GovernCode.
        // gov budget codex daily off; gov budget codex off. Without arguments: the budgets.
        const [provider, window, value, unitArg] = rest;
        const { settings } = await api.call("settings.get", {});
        const usage = `usage: gov budget [PROVIDER (${Object.keys(COUNTED_WINDOWS).join("|")}) N tokens|turns | PROVIDER [WINDOW] off]`;
        if (!provider) {
          const rows = Object.entries(settings.budgets as Record<string, { unit: string; windows: Record<string, number> }>).filter(([, b]) => Object.keys(b.windows).length);
          if (!rows.length) console.log(dim("no budgets: Runners are held by their own usage reports only"));
          for (const [p, b] of rows) console.log(`${p.padEnd(8)} ${Object.entries(b.windows).map(([w, n]) => `${n} ${b.unit} ${w}`).join(", ")}`);
          if (rows.length) console.log(dim(`${COUNTED_LABEL}: use outside GovernCode is not seen`));
          return 0;
        }
        let budgets = settings.budgets;
        if (window === "off") {
          budgets = { ...budgets }; delete budgets[provider];
        } else {
          if (!(window in COUNTED_WINDOWS)) throw new Error(usage);
          const cap = value === "off" ? null : Number(value);
          const unit = unitArg ?? budgets[provider]?.unit;   // the budget's unit, once it has one
          if (cap !== null && (!Number.isInteger(cap) || cap < 1 || (unit !== "tokens" && unit !== "turns"))) throw new Error(usage);
          budgets = setBudget(budgets, provider, window as CountedWindow, cap, cap === null ? undefined : unit as "tokens" | "turns");
        }
        await api.call("settings.set", { ...settings, budgets });   // the whole object: set replaces it
        const b = budgets[provider];
        if (!b) { console.log(`${provider}: no budget`); return 0; }
        console.log(`${provider}: at most ${Object.entries(b.windows).map(([w, n]) => `${n} ${b.unit} ${w}`).join(", ")}, ${COUNTED_LABEL}`);
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
        if (!provider || !model) throw new Error("usage: gov runner PROVIDER --model M [--effort low|medium|high|max]");
        const { settings } = await api.call("settings.get", {});
        await api.call("settings.set", { ...settings, runners: { ...settings.runners, [provider]: { model, effort: effort ?? null } } });
        console.log(`${provider}: defaults to ${model} · ${effort ?? "n/a"}`);
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
      case "connect": {
        // gov connect: the tools and whether each is connected. gov connect TOOL: sign it in for
        // GovernCode with its own sign-in (a link to open, a code to paste back).
        const tool = rest[0];
        if (!tool) {
          const { tools } = await api.call("tools.list", { measure: true });
          for (const t of tools) {
            const use = t.usage?.readings?.length ? ` · ${t.usage.readings.map((r: any) => `${r.window} ${r.usedPercent}% used`).join(", ")}` : "";
            const state = !t.installed ? "not installed" : !t.connected ? `not connected (gov connect ${t.tool})`
              : t.problem ? `needs attention: ${t.problem}` : "connected" + use;
            console.log(`${t.tool.padEnd(6)} ${t.name.padEnd(12)} ${state}`);
          }
          return 0;
        }
        if (!["agy", "claude", "codex", "grok"].includes(tool)) throw new Error("usage: gov connect [agy|claude|codex|grok]");
        // Codex: the browser hands the login back by itself; Grok: the code shown below is entered on the page. Nothing to paste here.
        const device = tool === "codex" || tool === "grok";
        const tty = answers();
        let id = "";
        api.onEvent(async (ev) => {
          if (ev.kind !== "connect") return;
          id = ev.id;
          if (ev.url && device) {
            console.log(warn(tool === "grok" ? "\nOpen this link, enter the code shown here and sign in; this finishes by itself when you are done:"
              : "\nOpen this link and sign in; this finishes by itself when you are done:"));
            console.log(ev.url);
          } else if (ev.url) {
            console.log(warn("\nOpen this link and sign in:"));
            console.log(ev.url);
            const code = (await tty.next("\nPaste the code it gives you here: ")).trim();
            if (code) await api.call("connect.input", { id, text: code });
            else await api.call("connect.cancel", { id });
          } else if (ev.text) console.log(dim(ev.text));
        });
        console.log(dim("Signing in inside GovernCode's sandbox, in a home that belongs to GovernCode (not your own setup)."));
        const r = await api.call("connect.start", { tool });
        tty.close();
        console.log(r.connected ? r.note : warn(r.note));
        return r.connected ? 0 : 1;
      }
      case "disconnect": {
        const tool = rest[0];
        if (!["agy", "claude", "codex"].includes(tool)) throw new Error("usage: gov disconnect agy|claude|codex");
        console.log((await api.call("tools.disconnect", { tool })).note);
        return 0;
      }
      case "reset": {
        // gov reset: the Controller forgets this project's conversation (the Trace keeps it all).
        const project = await currentProject(api);
        await api.call("conversation.reset", { project });
        console.log(`new conversation${project ? ` in ${project}` : " at Home"}`);
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
        if (!provider || !window || !Number.isInteger(n)) throw new Error("usage: gov reserve PROVIDER WINDOW PERCENT   (e.g. gov reserve codex weekly 15)");
        const { settings } = await api.call("settings.get", {});
        const reserves = { ...settings.reserves, [provider]: { ...(settings.reserves[provider] ?? {}), [window]: n } };
        await api.call("settings.set", { ...settings, reserves });   // the whole object: set replaces it
        console.log(`${provider}: keeps ${n}% of its ${window} window back`);
        return 0;
      }
      case "limits": {
        const { providers } = await api.call("limits.list", { measure: true });
        if (!providers.length) console.log(dim("no measured Runners"));
        for (const x of providers) {
          const windows = x.readings.map((r: any) => `${r.window} ${r.counted ? `${r.counted.used}/${r.counted.cap} ${r.counted.unit}` : `${r.usedPercent}%`}${r.resetsAt ? ` (resets ${r.resetsAt})` : ""}`).join(", ") || "not measured";
          const held = [x.reservedPercent ? `${x.reservedPercent}% reserved by running Specs` : "",
            x.owedPercent ? `${x.owedPercent}% held for finished Specs until the usage report catches up` : ""].filter(Boolean).join(", ");
          const rule = x.local ? `local: at most ${x.local.maxRunning} at once, ${x.local.maxMinutes} min each` : `${windows}  · keeps ${x.reservePercent}% back`;
          console.log(`${x.provider.padEnd(8)} ${x.verdict.ok ? "available" : "held     "}  ${rule}${held ? ` · ${held}` : ""}${x.counted ? ` · ${x.counted}` : ""}${x.unmetered ? " · unmetered (your opt-in)" : ""}${x.verdict.ok ? "" : `  ${dim(x.verdict.reason)}`}`);
        }
        return 0;
      }
      case "specs": {
        const project = await currentProject(api);
        const { specs } = await api.call("spec.list", { project: project ?? undefined });
        if (!specs.length) console.log(dim("no Specs yet"));
        for (const x of specs) console.log(`${x.id}  ${x.to.padEnd(8)} ${`${x.model} · ${x.effort ?? "n/a"}`.padEnd(20)} ${x.status.padEnd(13)} ${String(x.files.length).padStart(3)} files  ${dim(x.brief.slice(0, 50))}`);
        return 0;
      }
      case "diff": {
        const r = await api.call("spec.diff", { id: rest[0] });
        console.log(r.diff || dim("(no changes)"));
        return 0;
      }
      case "accept": {
        const r = await api.call("spec.accept", { id: rest[0] });
        console.log(`${r.id}: applied ${r.applied.length} file(s) to the project: ${r.applied.join(", ")}`);
        return 0;
      }
      case "discard": {
        await api.call("spec.discard", { id: rest[0] });
        console.log(`${rest[0]}: discarded`);
        return 0;
      }
      case "trace": {
        const project = await currentProject(api);
        // gov trace --jsonl: every event of this project (or all), one JSON object per line, for export.
        const jsonl = rest.includes("--jsonl");
        const { events } = await api.call("trace.list", { project: project ?? undefined, limit: jsonl ? 1000 : 50 });
        if (jsonl) { for (const e of events) console.log(JSON.stringify(e)); return 0; }
        for (const e of events) console.log(`${new Date(e.ts).toTimeString().slice(0, 8)}  ${e.kind.padEnd(16)} ${(e.project ?? "-").padEnd(12)} ${dim(e.actor)}`);
        return 0;
      }
      case "ask": {
        const project = await currentProject(api);
        const tty = answers();
        const r = await runAsk(api, project, rest.join(" "), tty);
        tty.close();
        console.log(dim(r.ok ? "— done" : `— failed: ${r.summary}`));
        return r.ok ? 0 : 1;
      }
      case "demo": {
        const i = rest.indexOf("--path");
        const tty = answers();
        try { return await runDemo(api, { path: i >= 0 ? rest[i + 1] : undefined, tty, runAsk, dim, warn }); }
        finally { tty.close(); }
      }
      default:
        console.error("usage: gov [--host HOST] [status|projects|new NAME [--path P]|open [PATH]|controller PROVIDER [--model M] [--effort E]|trace [--jsonl]|ask PROMPT|demo [--path P]|gates|gate ID allow|deny [--turn|--spec|--project]|allows [revoke R]|specs|diff S|accept S|discard S|turns|undo T|limits|settings|reserve P W N|budget [P W N tokens|turns|P [W] off]|local N M|runner P --model M [--effort E]|spec-models free|within|defaults|level relaxed|balanced|strict|personal claude|codex on|off|connect [agy|claude|codex]|disconnect TOOL|notes [edit|history|restore SEQ]|crew [...]|reset|daemon start|install|uninstall|tunnel [HOST [--remote-socket P]|--stop HOST]|socket-path]");
        return 2;
    }
  } finally {
    api.sock.end();
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(`gov: ${err.message}`); process.exit(1); });

async function daemon(verb: string | undefined): Promise<number> {
  const svc = await import("./service.ts");
  switch (verb) {
    case "install": console.log(`installed ${svc.install()} and started governcode.service`); return 0;
    case "uninstall": svc.uninstall(); console.log("stopped and disabled governcode.service"); return 0;
    case "start": {
      const state = stateDir(env);
      console.log(`govd started (pid ${svc.startOnce(state)}); log: ${join(state, "govd.log")}`);
      return 0;
    }
    default: console.error("usage: gov daemon start|install|uninstall"); return 2;
  }
}
