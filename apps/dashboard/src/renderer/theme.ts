// Light or dark: follows the system unless the user chose one in Settings. The choice is the
// Dashboard's own (kept in this window's storage), not a govd setting: it changes nothing an AI does.
import { useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "governcode.theme";
const listeners = new Set<(c: ThemeChoice) => void>();

export function themeChoice(): ThemeChoice {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function setThemeChoice(c: ThemeChoice): void {
  if (c === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, c);
  for (const f of listeners) f(c);
}

/** Keeps <html data-theme> on the resolved theme, and returns the user's choice. */
export function useTheme(): ThemeChoice {
  const [choice, setChoice] = useState<ThemeChoice>(themeChoice);
  useEffect(() => {
    listeners.add(setChoice);
    return () => { listeners.delete(setChoice); };
  }, []);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = choice === "system" ? (media.matches ? "dark" : "light") : choice;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [choice]);
  return choice;
}
