// A small set of line icons on a 24 px grid, drawn for GovernCode (no icon dependency).
const PATHS = {
  overview: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  inbox: "M4 13h4l1.5 2.5h5L16 13h4M5.5 6h13L20 13v5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18v-5z",
  chat: "M5 18.5V6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v7a2.5 2.5 0 0 1-2.5 2.5H9z",
  gauge: "M4.5 16a8 8 0 1 1 15 0M12 13l3.5-4",
  clock: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 7.5V12l3 2",
  shield: "M12 3.5 19 6v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6zM9 12l2 2 4-4",
  shieldX: "M12 3.5 19 6v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6zM9.5 9.5l5 5M14.5 9.5l-5 5",
  gear: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8",
  plus: "M12 5v14M5 12h14",
  folder: "M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5V17A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17z",
  branch: "M7 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM17 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 8v8M17 10c0 4-10 2-10 6",
  check: "M5 12.5 9.5 17 19 7",
  x: "M6 6l12 12M18 6 6 18",
  lock: "M7.5 10.5h9a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-5.5a2 2 0 0 1 2-2zM8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5",
  hourglass: "M7 4h10M7 20h10M8 4c0 4 8 4 8 8s-8 4-8 8M16 4c0 4-8 4-8 8",
  play: "M8 5.5v13l10.5-6.5z",
  undo: "M9 14 4.5 9.5 9 5M4.5 9.5h9a5.5 5.5 0 0 1 0 11H10",
  doc: "M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20zM14 3.5V8h4M9.5 12.5h5M9.5 16h5",
  people: "M9 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM3.5 19a5.5 5.5 0 0 1 11 0M17 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM15.5 14.6A4.5 4.5 0 0 1 21 19",
  note: "M5 4.5h14v15H5zM8.5 9h7M8.5 12.5h7M8.5 16h4",
  sparkle: "M12 4c.6 3.8 2.2 5.4 6 6-3.8.6-5.4 2.2-6 6-.6-3.8-2.2-5.4-6-6 3.8-.6 5.4-2.2 6-6z",
  home: "M4.5 11 12 4.5l7.5 6.5V19a1 1 0 0 1-1 1h-4v-5h-5v5h-4a1 1 0 0 1-1-1z",
  layers: "M12 4l8 4-8 4-8-4zM4 12l8 4 8-4M4 16l8 4 8-4",
  arrowUp: "M12 19V6M6.5 11.5 12 6l5.5 5.5",
  chevronDown: "M6 9l6 6 6-6",
  chevronRight: "M9 6l6 6-6 6",
  refresh: "M19 12a7 7 0 1 1-2.1-5M19 4.5V8h-3.5",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4",
  moon: "M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z",
  monitor: "M3.5 5h17v11h-17zM9 20h6M12 16v4",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className = "" }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
