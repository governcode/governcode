// npm start and npm run dev drop an inherited ELECTRON_RUN_AS_NODE, which would run Electron as plain Node.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronEnv } from "../scripts/electron.ts";

test("Electron starts without ELECTRON_RUN_AS_NODE, whatever the terminal had", () => {
  const url = "http://localhost:5174/";
  assert.deepEqual(electronEnv({ GOVERNCODE_DASHBOARD_DEV_URL: url }, { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1" }),
    { PATH: "/usr/bin", GOVERNCODE_DASHBOARD_DEV_URL: url });
  assert.ok(!("ELECTRON_RUN_AS_NODE" in electronEnv({ ELECTRON_RUN_AS_NODE: "1" }, {})));
  const base = { ELECTRON_RUN_AS_NODE: "1" };
  electronEnv({}, base);
  assert.equal(base.ELECTRON_RUN_AS_NODE, "1", "the caller's environment is left as it was");
  // npm start goes through it (a bare `electron .` would inherit the variable).
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts.start, "node scripts/start.ts");
});

test("npm start's launcher runs Electron on the app, without the variable, and passes its exit code on", () => {
  // A stand-in for the Electron binary (the electron package honours ELECTRON_OVERRIDE_DIST_PATH): no window opens.
  const dir = mkdtempSync(join(tmpdir(), "dashboard-start-"));
  try {
    // Where the package looks for the binary inside that folder ("electron" on Linux, Electron.app/... on macOS).
    const pathTxt = join(dirname(createRequire(import.meta.url).resolve("electron/package.json")), "path.txt");
    const bin = join(dir, existsSync(pathTxt) ? readFileSync(pathTxt, "utf8") : "electron");
    mkdirSync(dirname(bin), { recursive: true });
    writeFileSync(bin, '#!/bin/sh\necho "run-as-node=${ELECTRON_RUN_AS_NODE:-unset} args=$*"\nexit 3\n');
    chmodSync(bin, 0o755);
    const app = fileURLToPath(new URL("..", import.meta.url));
    let out = "", status = 0;
    try {
      out = execFileSync(process.execPath, [join(app, "scripts/start.ts"), "--x"], { encoding: "utf8",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ELECTRON_OVERRIDE_DIST_PATH: dir } });
    } catch (e) { const err = e as { stdout: string; status: number }; out = err.stdout; status = err.status; }
    assert.equal(out.trim(), `run-as-node=unset args=${app} --x`);
    assert.equal(status, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
