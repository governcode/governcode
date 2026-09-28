// Local Runners: a model on the user's own machine, through Ollama's HTTP API (#185 C).
//
// A local model gets no tools. It reads the files the Spec's scope names, and answers with whole
// new file contents as JSON; govd itself checks every path against the write scope and writes
// them into the Spec's workspace, which no AI tool can reach. Nothing is executed, so there is
// nothing to sandbox or gate beyond that check, and the result is reviewed like any other Spec.
// Limits for local models are about the machine, not money: at most N running, M minutes each.
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Measurement, UsageSource } from "./limits.ts";
import { safeTarget } from "./specstore.ts";

export const LOCAL_PROVIDERS = ["ollama"];

export function ollamaHost(): string {
  const h = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  return (/^https?:\/\//.test(h) ? h : `http://${h}`).replace(/\/+$/, "");
}

/** What Ollama says when it refuses: its own `error` text, or the status. */
async function refusal(r: Response): Promise<string> {
  const body = await r.text().catch(() => "");
  try { return String(JSON.parse(body).error || `HTTP ${r.status}`); } catch { return body.trim().slice(0, 300) || `HTTP ${r.status}`; }
}

/** Ollama as a Runner: available when it answers, with the models it has installed. There is no
 *  usage to read; a reading only says "it is there" (the Limit for local models is machine-based). */
export function ollamaUsage(host = ollamaHost()): UsageSource & { why(): string | null; models(): string[] } {
  let why: string | null = null;
  let models: string[] = [];
  return {
    provider: "ollama",
    why: () => why,
    models: () => models,
    async read(): Promise<Measurement | null> {
      try {
        const r = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (!r.ok) { why = `Ollama: ${await refusal(r)}`; return null; }
        models = ((await r.json()) as { models?: Array<{ name: string }> }).models?.map((m) => m.name) ?? [];
        why = models.length ? null : "Ollama has no models installed";
        return models.length ? { provider: "ollama", measuredAt: Date.now(), readings: [] } : null;
      } catch {
        why = `Ollama is not answering at ${host}`;
        return null;
      }
    },
  };
}

// What the model sees: the scope's files, as text, within a budget its context can hold.
const MAX_FILE = 64_000, MAX_CONTEXT = 48_000, MAX_OUT_FILE = 256_000, MAX_OUT_FILES = 20;

function gather(work: string, entries: string[]): { files: Array<{ path: string; text: string }>; skipped: string[] } {
  const files: Array<{ path: string; text: string }> = [], skipped: string[] = [], seen = new Set<string>();
  let used = 0;
  const add = (abs: string) => {
    const rel = relative(work, abs);
    if (seen.has(rel)) return;
    seen.add(rel);
    const st = lstatSync(abs);
    if (!st.isFile() || st.nlink > 1 || st.size > MAX_FILE) { if (st.isFile()) skipped.push(rel); return; }   // a hard link may name a file elsewhere
    const text = readFileSync(abs, "utf8");
    if (text.includes("\0") || used + text.length > MAX_CONTEXT) { skipped.push(rel); return; }
    used += text.length;
    files.push({ path: rel, text });
  };
  const walk = (abs: string, depth: number) => {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return;
    if (st.isFile()) return add(abs);
    if (!st.isDirectory() || depth > 6) return;
    for (const name of readdirSync(abs).sort()) if (name !== ".git" && name !== "node_modules") walk(join(abs, name), depth + 1);
  };
  for (const e of entries.length ? entries : ["."]) {
    if (isAbsolute(e)) continue;   // never "/" turned into the whole project: an absolute entry shows nothing
    const rel = e.replace(/^\.\/+/, "").replace(/\/+$/, "");
    try { walk(e === "." || e === "./" ? work : safeTarget(work, rel), 0); } catch { /* missing or unsafe: not shown */ }
  }
  return { files, skipped };
}

const SCHEMA = { type: "object", required: ["summary", "files"], properties: {
  summary: { type: "string" },
  files: { type: "array", items: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } } } } };

/** Checks the model's answer; returns the writes, or why it is refused (nothing is written then). */
export function planWrites(work: string, scopeWrite: string[], answer: unknown): { writes: Array<{ abs: string; rel: string; content: string }> } | { refused: string } {
  const a = answer as { files?: Array<{ path?: unknown; content?: unknown }> };
  if (!a || !Array.isArray(a.files)) return { refused: "the model's answer was not the expected JSON" };
  if (a.files.length > MAX_OUT_FILES) return { refused: `the model proposed ${a.files.length} files (at most ${MAX_OUT_FILES})` };
  const scopes = scopeWrite.map((w) => w.replace(/^\.\/+/, "").replace(/\/+$/, ""));
  const writes: Array<{ abs: string; rel: string; content: string }> = [];
  const seen = new Set<string>();
  for (const f of a.files) {
    if (typeof f?.path !== "string" || typeof f?.content !== "string") return { refused: "a proposed file had no path or content" };
    const rel = f.path.replace(/^\.\/+/, "");
    // One spelling per file: no "a/./b", "a//b" or trailing "/", so two entries can't name one file.
    if (!rel || rel.split("/").some((c) => c === "" || c === "." || c === "..")) return { refused: `${f.path}: not a plain relative file path` };
    if (rel.split("/").some((c) => c.toLowerCase() === ".git")) return { refused: `${rel}: never writes git's own files` };
    const key = rel.toLowerCase();   // also refuses README.md next to readme.md (would clash on some systems)
    if (seen.has(key)) return { refused: `${rel} is proposed twice` };
    for (const other of seen) if (key.startsWith(other + "/") || other.startsWith(key + "/")) return { refused: `${rel} is both a file and a folder in this answer` };
    seen.add(key);
    if (scopes.length && !scopes.some((w) => rel === w || rel.startsWith(w + "/"))) return { refused: `${rel} is outside the Spec's write scope (${scopes.join(", ")})` };
    if (f.content.length > MAX_OUT_FILE) return { refused: `${rel} is too large (${f.content.length} characters)` };
    let abs: string;
    try { abs = safeTarget(work, rel); } catch (e) { return { refused: e instanceof Error ? e.message : String(e) }; }
    try {
      const st = lstatSync(abs);
      if (!st.isFile()) return { refused: `${rel} exists and is not a regular file` };
      if (st.nlink > 1) return { refused: `${rel} is a hard link (it may be a file elsewhere); refused` };   // red-team 2026-09-27
    } catch { /* new file */ }
    // Every existing folder on the way must be a folder (README.md/child cannot be written).
    for (let d = dirname(rel); d !== "."; d = dirname(d)) {
      try { if (!lstatSync(join(work, d)).isDirectory()) return { refused: `${rel}: ${d} is a file, not a folder` }; } catch { /* created on write */ }
    }
    // Models often drop a text file's final newline; a missing one would show as a change of its own.
    writes.push({ abs, rel, content: f.content && !f.content.endsWith("\n") ? f.content + "\n" : f.content });
  }
  return { writes };
}

export type LocalHooks = { text(t: string): void; done(r: { ok: boolean; summary: string }): void };

/** One Spec on a local model. The caller's signal stops it; maxMinutes is the machine Limit. */
export async function runLocalTurn(o: { host?: string; model: string; work: string; scope: { read: string[]; write: string[] };
  prompt: string; maxMinutes: number; signal?: AbortSignal; hooks: LocalHooks }): Promise<void> {
  const host = o.host ?? ollamaHost();
  const started = Date.now();
  const { files, skipped } = gather(o.work, [...o.scope.read, ...o.scope.write]);
  const system = [
    "You are a Runner in GovernCode: a local model doing one small job (a Spec) for another AI.",
    "You cannot run commands or open files yourself; the files you need are below.",
    "Answer with JSON only: {\"summary\": \"one or two sentences on what you changed\", \"files\": [{\"path\": \"relative/path\", \"content\": \"the complete new content of that file\"}]}.",
    `List only files you change or create, each with its whole new content. You may write only: ${o.scope.write.length ? o.scope.write.join(", ") : "files in this project"}.`,
    "If the job cannot be done within that, return no files and say why in the summary.",
  ].join("\n");
  const shown = files.map((f) => `=== ${f.path} ===\n${f.text}`).join("\n\n") || "(no files in scope yet)";
  const user = `${o.prompt}\n\nFiles:\n\n${shown}${skipped.length ? `\n\n(Not shown, too large or binary: ${skipped.join(", ")})` : ""}`;
  const signal = AbortSignal.any([o.signal ?? new AbortController().signal, AbortSignal.timeout(o.maxMinutes * 60_000)]);
  let content = "", tokensOut = 0, tokensIn = 0, finished = false;
  try {
    const r = await fetch(`${host}/api/chat`, { method: "POST", signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: o.model, stream: true, think: false, format: SCHEMA,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        options: { temperature: 0.2, num_ctx: 16384 } }) });
    if (!r.ok || !r.body) return o.hooks.done({ ok: false, summary: `Ollama: ${await refusal(r)}` });
    o.hooks.text(`${o.model} is working locally (${files.length} file${files.length === 1 ? "" : "s"} in view).`);
    const decoder = new TextDecoder();
    let buf = "", lastNote = Date.now(), failed = "";
    const record = (line: string) => {   // one NDJSON record of Ollama's stream
      if (!line.trim() || failed) return;
      let m: any;
      try { m = JSON.parse(line); } catch { failed = "an unreadable line in its answer stream"; return; }
      if (m.error) { failed = String(m.error); return; }
      content += m.message?.content ?? "";
      if (m.done) { finished = true; tokensOut = m.eval_count ?? 0; tokensIn = m.prompt_eval_count ?? 0; }
    };
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) { record(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
      if (failed) break;
      if (Date.now() - lastNote > 10_000) { lastNote = Date.now(); o.hooks.text(`… ${content.length} characters so far`); }
    }
    record(buf + decoder.decode());   // the last record may come without a newline
    if (failed) return o.hooks.done({ ok: false, summary: `Ollama: ${failed}` });
    if (!finished) return o.hooks.done({ ok: false, summary: "Ollama's answer ended early (no final record); nothing written" });
  } catch (e) {
    const why = signal.aborted ? (o.signal?.aborted ? String(o.signal.reason ?? "stopped") : `stopped at its ${o.maxMinutes}-minute local Limit`)
      : `Ollama did not answer at ${host} (${e instanceof Error ? e.message : e})`;
    return o.hooks.done({ ok: false, summary: why });
  }
  let answer: unknown;
  try { answer = JSON.parse(content); } catch { return o.hooks.done({ ok: false, summary: "the model's answer was not valid JSON" }); }
  const plan = planWrites(o.work, o.scope.write, answer);
  if ("refused" in plan) return o.hooks.done({ ok: false, summary: `refused, nothing written: ${plan.refused}` });
  try {
    for (const w of plan.writes) {
      mkdirSync(dirname(w.abs), { recursive: true });
      writeFileSync(w.abs, w.content);
    }
  } catch (e) {
    // The Spec fails, so this half-written workspace is never offered for review.
    return o.hooks.done({ ok: false, summary: `could not write the proposed files: ${e instanceof Error ? e.message : e}` });
  }
  const summary = String((answer as { summary?: unknown }).summary ?? "").slice(0, 2000);
  const stats = `${o.model} · ${tokensIn} tokens in, ${tokensOut} out · ${Math.round((Date.now() - started) / 1000)} s`;
  o.hooks.text(summary ? `${summary}\n(${stats})` : stats);
  o.hooks.done({ ok: true, summary: summary || `wrote ${plan.writes.map((w) => w.rel).join(", ") || "nothing"}` });
}
