import { test } from "node:test";
import assert from "node:assert/strict";
import { unitFile } from "../src/service.ts";

test("the systemd unit runs govd with the running node and restarts on failure", () => {
  const u = unitFile("/usr/bin/node", "/opt/governcode/packages/govd/src/main.ts");
  assert.match(u, /^ExecStart=\/usr\/bin\/node \/opt\/governcode\/packages\/govd\/src\/main\.ts$/m);
  assert.match(u, /^Restart=on-failure$/m);
  assert.match(u, /^WantedBy=default\.target$/m);
});
