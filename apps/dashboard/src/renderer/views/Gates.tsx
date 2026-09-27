// Gates: every approval waiting right now, from any project, answerable here.
import { useState } from "react";
import type { Gate } from "../api.ts";
import { Empty, GateCard } from "../ui.tsx";

export function Gates({ gates, onAnswered }: { gates: Gate[]; onAnswered: () => void }) {
  const [answered, setAnswered] = useState<Record<string, "allow" | "deny">>({});
  return (
    <section className="view">
      <div className="view-head">
        <h1>Gates</h1>
        <span className="dim">Approvals waiting. Allow runs exactly the request shown, once.</span>
      </div>
      <div className="scroll">
        {!gates.length ? <Empty title="No Gates waiting"><p className="dim">When a Controller or Runner needs approval, it waits here.</p></Empty>
          : gates.map((g) => (
            <GateCard key={g.id} id={g.id} tool={g.tool} canonical={g.canonical} project={g.project} opened={g.opened}
              state={answered[g.id] ?? "waiting"} onAnswered={(a) => { setAnswered((m) => ({ ...m, [g.id]: a })); onAnswered(); }} />
          ))}
      </div>
    </section>
  );
}
