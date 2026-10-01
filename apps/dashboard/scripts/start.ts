// npm start: the built app in Electron, also from a terminal inside another Electron app (see electron.ts).
import { fileURLToPath } from "node:url";
import { startElectron } from "./electron.ts";

const child = startElectron(fileURLToPath(new URL("..", import.meta.url)), process.argv.slice(2));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
