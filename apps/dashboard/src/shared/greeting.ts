// The Overview's greeting: a few lines for each part of the day. One is picked per day and part of
// the day, so it stays the same while the screen refreshes and changes with the clock.

export type DayPart = "morning" | "afternoon" | "evening" | "night";

export const GREETINGS: Record<DayPart, string[]> = {
  morning: [
    "Good morning",
    "Morning. Fresh coffee, clean diffs.",
    "Good morning. The crew is standing by.",
    "Rise and review.",
    "Morning. Let's ship something small and good.",
    "Good morning. Overnight is all in the Trace.",
  ],
  afternoon: [
    "Good afternoon",
    "Afternoon. Steady hands, small commits.",
    "Good afternoon. Second wind incoming.",
    "Afternoon. The diffs await your verdict.",
    "Good afternoon. Keep the momentum.",
    "Post-lunch focus mode: engaged.",
  ],
  evening: [
    "Good evening",
    "Evening. Wrap it up, or wind it up?",
    "Good evening. Leave it better than you found it.",
    "Evening. A fine hour to read what the Runners wrote.",
    "Good evening. The sandbox never clocks out.",
    "Evening. One more Spec, then dinner?",
  ],
  night: [
    "Burning the midnight oil?",
    "Still up? So is the sandbox.",
    "The quiet hours. Perfect for deep work.",
    "Late night. Small changes, careful reviews.",
    "Night owl mode. Checkpoints have your back.",
    "Up early, or up late? Either way, welcome.",
  ],
};

/** 05:00 to 11:59 morning, to 16:59 afternoon, to 21:59 evening, then night until 04:59. */
export function dayPart(at: Date): DayPart {
  const h = at.getHours();
  return h >= 5 && h < 12 ? "morning" : h >= 12 && h < 17 ? "afternoon" : h >= 17 && h < 22 ? "evening" : "night";
}

/** The greeting for this local day and part of the day. A night after midnight belongs to the day before. */
export function greeting(at: Date): string {
  const part = dayPart(at);
  const day = new Date(at.getTime() - (part === "night" && at.getHours() < 5 ? 86_400_000 : 0));
  const key = `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}-${part}`;
  let hash = 0;
  for (const c of key) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const lines = GREETINGS[part];
  return lines[hash % lines.length];
}
