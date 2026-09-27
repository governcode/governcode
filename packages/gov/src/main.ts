#!/usr/bin/env node
// gov: the command line. A thin client of govd over its Unix socket. Gates are answered here,
// in the user's own terminal, which the sandboxed harness has no way to reach.
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { createInterface as ask } from "node:readline/promises";
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
    createInterface({ input: sock }).on("line", (line) => {
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
      case "trace": {
        const project = await currentProject(api);
        const { events } = await api.call("trace.list", { project: project ?? undefined, limit: 50 });
        for (const e of events) console.log(`${e.ts.slice(11, 19)}  ${e.kind.padEnd(16)} ${(e.project ?? "-").padEnd(12)} ${dim(e.actor)}`);
        return 0;
      }
      case "ask": {
        const project = await currentProject(api);
        const prompt = rest.join(" ");
        const tty = ask({ input: process.stdin, output: process.stdout });
        api.onEvent(async (ev) => {
          if (ev.kind === "text") process.stdout.write(ev.text + "\n");
          else if (ev.kind === "tool") console.log(dim(`· ${ev.name}`));
          else if (ev.kind === "gate") {
            console.log(warn(`\nGate: the Controller wants to use ${ev.tool}. Exactly this will run:`));
            console.log(ev.canonical);
            const a = (await tty.question("Allow once? [y/N] ")).trim().toLowerCase();
            await api.call("gate.answer", { id: ev.id, answer: a === "y" || a === "yes" ? "allow" : "deny" });
          }
        });
        const r = await api.call("ask", { project, prompt });
        tty.close();
        console.log(dim(r.ok ? "— done" : `— failed: ${r.summary}`));
        return r.ok ? 0 : 1;
      }
      default:
        console.error("usage: gov [status|projects|new NAME [--path P]|open [PATH]|controller PROVIDER [--model M] [--effort E]|trace|ask PROMPT]");
        return 2;
    }
  } finally {
    api.sock.end();
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(`gov: ${err.message}`); process.exit(1); });
