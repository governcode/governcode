// Where govd keeps things. XDG on Linux; ~/Library on macOS arrives with the Seatbelt port.
import { homedir } from "node:os";
import { join } from "node:path";

const env = process.env;
const home = homedir();

export const stateDir = env.GOVERNCODE_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(home, ".local/state"), "governcode");
export const runtimeDir = env.GOVERNCODE_RUNTIME_DIR ?? join(env.XDG_RUNTIME_DIR ?? stateDir, "governcode");
export const socketPath = join(runtimeDir, "govd.sock");
export const ledgerPath = join(stateDir, "trace.sqlite");
export const policyDir = join(stateDir, "policies");
export const homeDir = join(stateDir, "home"); // Home's read-only scratch folder
