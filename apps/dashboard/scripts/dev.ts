// npm run dev: the renderer from Vite's dev server (hot reload), main and preload built once,
// then Electron pointed at the dev server. Restart it to pick up main or preload changes.
import { createServer, build } from "vite";
import { appDir, MAIN, nodeConfig, PRELOAD, rendererConfig } from "./configs.ts";
import { startElectron } from "./electron.ts";

const server = await createServer(rendererConfig(true));
await server.listen();
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error("the Vite dev server has no local URL");
await build(nodeConfig(...MAIN));
await build(nodeConfig(...PRELOAD));

const child = startElectron(appDir, [], { GOVERNCODE_DASHBOARD_DEV_URL: url });
child.on("exit", async (code) => { await server.close(); process.exit(code ?? 0); });
