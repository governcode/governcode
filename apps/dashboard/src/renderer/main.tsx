import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { WatchWindow } from "./WatchWindow.tsx";
import { themeChoice } from "./theme.ts";
import "./styles.css";

// The theme before the first paint, so a light system never flashes dark.
const choice = themeChoice();
document.documentElement.dataset.theme = choice === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : choice;

// The Watch window loads this same page at #watch: only the live view, nothing to change.
const watchOnly = location.hash === "#watch";
createRoot(document.getElementById("root")!).render(<StrictMode>{watchOnly ? <WatchWindow /> : <App />}</StrictMode>);
