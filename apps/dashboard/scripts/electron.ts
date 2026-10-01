// Electron for npm start and npm run dev. Started from a terminal inside another Electron app (an
// editor, T3 Code), ELECTRON_RUN_AS_NODE can be inherited; Electron would then run as plain Node
// and crash (electron.app is undefined). The release launcher unsets it too.
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";

/** The environment Electron starts with: `base` plus `extra`, without ELECTRON_RUN_AS_NODE. */
export function electronEnv(extra: NodeJS.ProcessEnv = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** Runs Electron on `appDir`; Ctrl-C and SIGTERM are passed on to it. */
export function startElectron(appDir: string, args: string[] = [], extra: NodeJS.ProcessEnv = {}): ChildProcess {
  // Loaded here rather than imported: the electron package finds (and if need be fetches) its binary when loaded.
  const electronPath = createRequire(import.meta.url)("electron") as string;
  const child = spawn(electronPath, [appDir, ...args], { stdio: "inherit", env: electronEnv(extra) });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
  return child;
}
