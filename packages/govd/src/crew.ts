// The Crew card (design 2026-09-28): how a project's crew works, set by the user, enforced by
// govd. Stored as Trace events (the latest wins), so every change is on the record.
import { Crew, type CrewValue } from "@governcode/protocol";
import type { Ledger } from "./ledger.ts";

export const DEFAULT_CREW: CrewValue = Crew.parse({});

export function crewOf(L: Ledger, project: string): CrewValue {
  const last = L.eventsOfKind(project, ["crew.set"], 1).at(-1);
  const parsed = last ? Crew.safeParse(last.data.crew) : null;
  return parsed?.success ? parsed.data : DEFAULT_CREW;
}

export function setCrew(L: Ledger, project: string, crew: CrewValue): CrewValue {
  const value = Crew.parse(crew);
  L.append(project, "crew.set", "user", { crew: value });
  return value;
}

/** May this Runner take a Spec in this project? The reason when not. */
export function runnerAllowed(crew: CrewValue, runner: string): string | null {
  if (crew.handoff === "off") return "the user turned handing off off for this project: do the work yourself, or tell the user it needs a Runner";
  if (crew.runners && !crew.runners.includes(runner)) return `the user's Crew card for this project allows only: ${crew.runners.join(", ") || "no Runners"}`;
  return null;
}

/** What the Controller is told about the Crew card, each turn (information; govd enforces it). */
export function crewBrief(crew: CrewValue): string {
  const lines = [
    crew.controllerWorks ? "You may do work yourself in this project (under the usual Gates)."
      : "You plan and hand off only: the user chose that you do not change this project yourself (the sandbox makes it read-only for you).",
    crew.handoff === "off" ? "Handing off is off: work alone; there are no Runners for this project."
      : crew.handoff === "plan" ? "Before handing off, post a game plan with the plan tool; handoffs the user approves there run without asking again, others ask."
      : "Each handoff to a paid Runner waits for the user's approval at a Gate.",
    ...(crew.handoff !== "off" && crew.runners ? [`Runners allowed: ${crew.runners.join(", ") || "none"}.`] : []),
    ...(Object.keys(crew.maxPercent).length ? [`Most one Spec may reserve: ${Object.entries(crew.maxPercent).map(([r, n]) => `${r} ${n}%`).join(", ")}.`] : []),
    crew.subagents.controller ? "" : "Do not start subagents: the user turned them off for this project.",
  ].filter(Boolean);
  return lines.join(" ");
}
