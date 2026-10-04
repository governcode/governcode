// Trusted fixture worker only. Environment poison is invented and loader poison
// is installed after bootstrap, so it cannot inject code into the fixture itself.
import { allocateAcpProbeContext } from "../../src/acp-probe-context.ts";
import { lstat } from "node:fs/promises";

const parent = process.argv[2], mask = Number(process.argv[3]);
process.umask(mask);
for (const key of ["NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONPATH", "RUBYOPT"])
  process.env[key] = "invented-fixture-poison";
const inventedEnv = process.env;
let reads = 0;
process.env = new Proxy(Object.create(null), {
  get() { reads++; throw new Error("fixture environment read"); },
  ownKeys() { reads++; throw new Error("fixture environment enumeration"); },
  getOwnPropertyDescriptor() { reads++; throw new Error("fixture environment descriptor read"); },
});
let output: object;
try {
  const context = await allocateAcpProbeContext({ parent });
  const modes = await Promise.all([context.root, ...Object.values(context.directories)].map(async path =>
    Number((await lstat(path, { bigint: true })).mode & 0o7777n)));
  output = { root: context.root, env: context.env, modes, mask: process.umask(), reads };
} catch (error) {
  output = { error, mask: process.umask(), reads };
} finally { process.env = inventedEnv; }
process.stdout.write(JSON.stringify(output));
