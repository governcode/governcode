// Ctrl K: jump to any place, open a project's tab, or answer a Gate whose whole request fits in the
// row (the same rule as the Overview; anything longer opens in Needs you). Keyboard first: type to
// filter, arrows to move, Enter to run, Escape to close. Answers go to govd like any other.
// The highlight follows an item, never a position: if the lists change while the palette is open, a
// different Gate can never slide under it. It never starts on an answer, and one answer at a time.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { gateFitsInline } from "../../shared/status.ts";
import { filterItems, initialSelection, moveSelection, selected } from "../../shared/palette.ts";
import { call, type Gate, type Project, type Spec } from "../api.ts";
import { providerName } from "../brand.tsx";
import { Icon, type IconName } from "../icons.tsx";
import { setThemeChoice } from "../theme.ts";
import type { Place, Tab } from "./Sidebar.tsx";

type Item = { id: string; group: string; label: string; detail?: string; icon: IconName; tone?: "amber" | "accent"; answer?: boolean; hidden?: boolean; run: () => void | Promise<void> };
const TAB_NAMES: Array<[Tab, string]> = [["conversation", "Conversation"], ["specs", "Specs"], ["checkpoints", "Checkpoints"], ["notes", "Notes"], ["trace", "Trace"], ["crew", "Crew card"]];

export function Palette(props: { projects: Project[]; gates: Gate[]; specs: Spec[]; onPlace: (p: Place) => void; onClose: () => void;
  onGatesChanged: () => void; onNewProject: () => void; onOpenFolder: () => void }) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState<string | null>(null);   // the highlighted item's id
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Focus moves in, and back where it was on close.
    const before = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => { before?.focus?.(); };
  }, []);

  const items = useMemo<Item[]>(() => {
    const go = (place: Place) => () => { props.onPlace(place); props.onClose(); };
    const answer = (g: Gate, a: "allow" | "deny") => async () => {
      await call("gate.answer", { id: g.id, answer: a });
      props.onGatesChanged();
      props.onClose();
    };
    const out: Item[] = [];
    for (const g of props.gates) {
      const where = g.project ?? "Home";
      if (gateFitsInline(g.canonical)) {
        const detail = `${where} · ${g.tool} · ${g.canonical}`;
        out.push({ id: `allow:${g.id}`, group: "Waiting for you", label: `Allow ${g.id} once`, detail, icon: "lock", tone: "amber", answer: true, run: answer(g, "allow") });
        out.push({ id: `deny:${g.id}`, group: "Waiting for you", label: `Deny ${g.id}`, detail, icon: "x", tone: "amber", answer: true, run: answer(g, "deny") });
      } else {
        out.push({ id: `read:${g.id}`, group: "Waiting for you", label: `Read ${g.id} in full`, detail: `${where} · ${g.tool} · a longer request`, icon: "lock", tone: "amber", run: go({ kind: "global", id: "needs" }) });
      }
    }
    for (const s of props.specs.filter((x) => x.status === "needs-review")) {
      out.push({ id: `review:${s.id}`, group: "Waiting for you", label: `Review ${s.id}`, detail: `${s.project} · ${providerName(s.to)} · ${s.brief.split("\n")[0]}`, icon: "branch", tone: "amber",
        run: go({ kind: "project", name: s.project, tab: "specs" }) });
    }
    const places: Array<[Place, string, IconName]> = [[{ kind: "global", id: "overview" }, "Overview", "overview"], [{ kind: "global", id: "needs" }, "Needs you", "inbox"], [{ kind: "global", id: "watch" }, "Watch", "eye"],
      [{ kind: "global", id: "home" }, "Home (no project)", "home"], [{ kind: "global", id: "allowance" }, "Allowance", "gauge"],
      [{ kind: "global", id: "trace" }, "Trace", "clock"], [{ kind: "global", id: "settings" }, "Settings", "gear"]];
    for (const [place, label, icon] of places) out.push({ id: `go:${label}`, group: "Go to", label, icon, run: go(place) });
    for (const p of props.projects) {
      out.push({ id: `p:${p.name}`, group: "Projects", label: p.name, detail: `Conversation · ${providerName(p.controller.provider)}`, icon: "folder", run: go({ kind: "project", name: p.name, tab: "conversation" }) });
      for (const [tab, name] of TAB_NAMES.slice(1)) {
        out.push({ id: `p:${p.name}:${tab}`, group: "Projects", label: `${p.name} · ${name}`, icon: "chevronRight", hidden: true, run: go({ kind: "project", name: p.name, tab }) });
      }
    }
    out.push({ id: "new", group: "Actions", label: "New project", icon: "plus", run: () => { props.onClose(); props.onNewProject(); } });
    out.push({ id: "open", group: "Actions", label: "Open a folder as a project", icon: "folder", run: () => { props.onClose(); props.onOpenFolder(); } });
    out.push({ id: "light", group: "Actions", label: "Appearance: Light", icon: "sun", run: () => { setThemeChoice("light"); props.onClose(); } });
    out.push({ id: "dark", group: "Actions", label: "Appearance: Dark", icon: "moon", run: () => { setThemeChoice("dark"); props.onClose(); } });
    out.push({ id: "system", group: "Actions", label: "Appearance: Match system", icon: "monitor", run: () => { setThemeChoice("system"); props.onClose(); } });
    return out;
  }, [props]);

  // Project tabs show only once searched for (shared/palette.ts has the rules, and their tests).
  const shown = filterItems(items, query);
  // A new search starts on its first result that is not an answer; an answer is chosen by moving to it.
  useEffect(() => { setSel(initialSelection(shown)); }, [query]);   // only when the search changes
  const current = selected(shown, sel);   // null when the highlighted item went away: nothing runs
  const at = current ? shown.indexOf(current) : -1;
  useEffect(() => { list.current?.querySelector(".it.on")?.scrollIntoView({ block: "nearest" }); }, [sel]);

  const run = async (it: Item | undefined) => {
    if (!it || busy) return;
    setBusy(true); setError(null);
    try { await it.run(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const move = (by: 1 | -1) => setSel(moveSelection(shown, sel, by));
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();   // keys here are the palette's, not a dialog's below it
    if (e.key === "Escape") { e.preventDefault(); props.onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") { e.preventDefault(); if (current) void run(current); }
    else if (e.key === "Tab") { e.preventDefault(); input.current?.focus(); }   // focus stays in the palette
  };

  let last = "";
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKey}>
        <div className="q"><Icon name="search" size={18} />
          <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Jump to a project or screen, answer a Gate…"
            aria-label="Search" aria-controls="palette-list" aria-activedescendant={at >= 0 ? `pi-${shown[at].id}` : undefined} /></div>
        <div className="items" id="palette-list" role="listbox" ref={list}>
          {!shown.length && <div className="none">Nothing matches “{query}”.</div>}
          {shown.map((it, i) => {
            const head = it.group !== last ? (last = it.group) : null;
            return (
              <div key={it.id}>
                {head && <div className="grp">{head}</div>}
                <div id={`pi-${it.id}`} role="option" aria-selected={i === at} aria-disabled={busy} className={`it ${i === at ? "on" : ""}`}
                  onMouseMove={() => setSel(it.id)} onClick={() => void run(it)}>
                  <span className={`ic ${it.tone ?? ""}`}><Icon name={it.icon} size={14} /></span>
                  <span className="lbl">{it.label}{it.detail && <span className="det">{it.detail}</span>}</span>
                  {i === at && <kbd>↵</kbd>}
                </div>
              </div>
            );
          })}
        </div>
        {error && <div className="perr error small">{error}</div>}
        <div className="foot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>↵</kbd> run</span><span><kbd>Esc</kbd> close</span>
          <span className="spacer" /><span>Gate answers are recorded in the Trace</span></div>
      </div>
    </div>
  );
}
