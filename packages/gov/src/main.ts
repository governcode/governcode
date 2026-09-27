#!/usr/bin/env node
// gov: the command line. A thin client of govd over its Unix socket. Gates are answered here,
// in the user's own terminal, which the sandboxed harness has no way to reach.
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";

const env = process.env;
const runtimeDir = env.GOVERNCODE_RUNTIME_DIR ?? join(env.XDG_RUNTIME_DIR ?? join(homedir(), ".local/state/governcode"), "governcode");
const socketPath = join(runtimeDir, "govd.sock");

type Reply = { result?: any; error?: { code: number; message: string } };

function open(): Promise<{ call(method: string, params?: unknown): Promise<any>; onEvent(f: (e: any) => void): void; sock: Socket }> {
  return new Promise((ok, fail) => {
    const sock = connect(socketPath);
    let next = 1;
    const waiting = new Map<number, (r: Reply) => void>();
    let listener: (e: any) => void = () => {};
    sock.once("error", () => fail(new Error(`govd is not running (no socket at ${socketPath}). Start it with: npm run govd`)));
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

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const warn = (s: string) => `\x1b[33m${s}\x1b[0m`;

async function currentProject(api: Awaited<ReturnType<typeof open>>): Promise<string | null> {
  const here = resolve(process.cwd());
  const { projects } = await api.call("project.list");
  const match = projects.filter((p: any) => here === p.path || here.startsWith(p.path + "/")).sort((a: any, b: any) => b.path.length - a.path.length)[0];
  return match?.name ?? null;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "daemon") return daemon(rest[0]);
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
        await api.call("controller.set", { project, controller: { provider: rest[0] ?? "claude-code",
          model: m >= 0 ? rest[m + 1] : "opus", effort: e >= 0 ? rest[e + 1] : "high" } });
        console.log(`Controller for ${project}: ${rest[0] ?? "claude-code"}`);
        return 0;
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
        const [id, answer] = rest;
        if (!id || (answer !== "allow" && answer !== "deny")) throw new Error("usage: gov gate G-N allow|deny");
        await api.call("gate.answer", { id, answer });
        console.log(`${id}: ${answer === "allow" ? "allowed once" : "denied"}`);
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
      case "limits": {
        const { providers } = await api.call("limits.list", { measure: true });
        if (!providers.length) console.log(dim("no measured Runners"));
        for (const x of providers) {
          const windows = x.readings.map((r: any) => `${r.window} ${r.usedPercent}%${r.resetsAt ? ` (resets ${r.resetsAt})` : ""}`).join(", ") || "not measured";
          const held = [x.reservedPercent ? `${x.reservedPercent}% reserved` : "", x.owedPercent ? `${x.owedPercent}% owed` : ""].filter(Boolean).join(", ");
          console.log(`${x.provider.padEnd(8)} ${x.verdict.ok ? "available" : "held     "}  ${windows}  · keeps ${x.reservePercent}% back${held ? ` · ${held}` : ""}${x.verdict.ok ? "" : `  ${dim(x.verdict.reason)}`}`);
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
        const { events } = await api.call("trace.list", { project: project ?? undefined, limit: 50 });
        for (const e of events) console.log(`${new Date(e.ts).toTimeString().slice(0, 8)}  ${e.kind.padEnd(16)} ${(e.project ?? "-").padEnd(12)} ${dim(e.actor)}`);
        return 0;
      }
      case "ask": {
        const project = await currentProject(api);
        const prompt = rest.join(" ");
        const tty = answers();
        api.onEvent(async (ev) => {
          if (ev.kind === "text") process.stdout.write(ev.text + "\n");
          else if (ev.kind === "tool") console.log(dim(`· ${ev.name}`));
          else if (ev.kind === "spec") console.log(warn(`\n${ev.id} → Runner · ${ev.to}: ${ev.brief}`));
          else if (ev.kind === "spec.text") console.log(dim(`  ${ev.id} · ${ev.text.slice(0, 200)}`));
          else if (ev.kind === "spec.tool") console.log(dim(`  ${ev.id} · ${ev.name}`));
          else if (ev.kind === "gate") {
            console.log(warn(`\nGate: the Controller wants to use ${ev.tool}. Exactly this will run:`));
            console.log(ev.canonical);
            const a = (await tty.next("Allow once? [y/N] ")).trim().toLowerCase();
            if (!a) console.log("");
            await api.call("gate.answer", { id: ev.id, answer: a === "y" || a === "yes" ? "allow" : "deny" });
          } else if (ev.kind === "proposal") {
            console.log(warn(`\nThe Controller proposes a new project: ${ev.name} at ${ev.path}${ev.git ? " (git init, branch main)" : ""}`));
            if (ev.reason) console.log(dim(ev.reason));
            const a = (await tty.next("Create it? [y/N] ")).trim().toLowerCase();
            const r = await api.call("proposal.answer", { id: ev.id, answer: a === "y" || a === "yes" ? "create" : "cancel" });
            console.log(dim(r.created ? `created ${r.created.name} · gov open ${r.created.path}` : "not created"));
          }
        });
        const r = await api.call("ask", { project, prompt });
        tty.close();
        console.log(dim(r.ok ? "— done" : `— failed: ${r.summary}`));
        return r.ok ? 0 : 1;
      }
      default:
        console.error("usage: gov [status|projects|new NAME [--path P]|open [PATH]|controller PROVIDER [--model M] [--effort E]|trace|ask PROMPT|gates|gate ID allow|deny|specs|diff S|accept S|discard S|turns|undo T|limits|daemon start|install|uninstall]");
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
      const state = env.GOVERNCODE_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "governcode");
      console.log(`govd started (pid ${svc.startOnce(state)}); log: ${join(state, "govd.log")}`);
      return 0;
    }
    default: console.error("usage: gov daemon start|install|uninstall"); return 2;
  }
}
