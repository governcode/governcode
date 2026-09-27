// npm run dev: the renderer from Vite's dev server (hot reload), main and preload built once,
// then Electron pointed at the dev server. Restart it to pick up main or preload changes.
import { spawn } from "node:child_process";
import { createServer, build } from "vite";
import electronPath from "electron";
import { appDir, MAIN, nodeConfig, PRELOAD, rendererConfig } from "./configs.ts";

const server = await createServer(rendererConfig(true));
await server.listen();
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error("the Vite dev server has no local URL");
await build(nodeConfig(...MAIN));
await build(nodeConfig(...PRELOAD));

const child = spawn(electronPath as unknown as string, [appDir], {
  stdio: "inherit",
  env: { ...process.env, GOVERNCODE_DASHBOARD_DEV_URL: url },
});
child.on("exit", async (code) => { await server.close(); process.exit(code ?? 0); });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
