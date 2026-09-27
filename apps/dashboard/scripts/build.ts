// npm run build: renderer, then main and preload, into dist/.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { build } from "vite";
import { appDir, MAIN, nodeConfig, PRELOAD, rendererConfig } from "./configs.ts";

rmSync(join(appDir, "dist"), { recursive: true, force: true });
await build(rendererConfig(false));
await build(nodeConfig(...MAIN));
await build(nodeConfig(...PRELOAD));
console.log("dashboard: built dist/ (npm start -w apps/dashboard to run it)");
