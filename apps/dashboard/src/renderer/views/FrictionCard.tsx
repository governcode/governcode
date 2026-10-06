// This week's friction, on the Overview: how often you were asked, what your rules let through, the
// kinds of step you allowed every time (candidates for a standing allow) and those that probably ran
// into the sandbox (an estimate). govd counts it from the Trace (friction.report); nothing changes.
import { useCallback, useEffect, useRef, useState } from "react";
import { kindName, type FrictionReport } from "@governcode/protocol/friction";
import { call, useWatch } from "../api.ts";
import { Icon } from "../icons.tsx";

const COUNTED = new Set(["gate.opened", "gate.allowed", "gate.denied", "sandbox.blocked"]);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function FrictionCard() {
  const [r, setR] = useState<FrictionReport | null>(null);
  const [missing, setMissing] = useState(false);   // an older govd has no friction.report: no card
  const load = useCallback(async () => {
    try { setR((await call<{ report: FrictionReport }>("friction.report", { days: 7 })).report); }
    catch { setMissing(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // A busy turn asks and lets through many steps: counted again at most every few seconds.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useWatch((w) => {
    if (w.kind !== "trace" || !COUNTED.has(w.event.kind) || pending.current) return;
    pending.current = setTimeout(() => { pending.current = null; void load(); }, 3000);
  });
  useEffect(() => () => { if (pending.current) clearTimeout(pending.current); }, []);
  if (missing || !r) return null;
  const g = r.gates;
  const everyTime = r.kinds.filter((k) => k.allowedEveryTime).slice(0, 3);
  const blocked = r.kinds.filter((k) => k.blocked).sort((a, b) => b.blocked - a.blocked).slice(0, 3);
  return (
    <div className="card note-card friction">
      <span className="tile"><Icon name="lock" /></span>
      <div><b>This week</b>
        <p>{g.opened ? `${plural(g.opened, "Gate")} · ${g.allowed} allowed and ${g.denied} denied by you` : "No Gates asked you anything."}
          {g.passed ? ` · ${plural(g.passed, "step")} let through by your rules or plans` : ""}.</p>
        {!!everyTime.length && <p>Allowed every time: {everyTime.map((k) => kindName(k.kind)).join(", ")}. A standing allow would skip those questions.</p>}
        {!!blocked.length && <p>Probably blocked by the sandbox (an estimate): {blocked.map((k) => `${kindName(k.kind)} (${k.blocked})`).join(", ")}.</p>}
        <p className="dim">Details: gov friction</p></div>
    </div>
  );
}
