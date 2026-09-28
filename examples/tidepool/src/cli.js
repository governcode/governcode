#!/usr/bin/env node
// tidepool FILE: prints the high and low waters in a tide table.
import { readFileSync } from "node:fs";
import { parse, turningPoints, range } from "./tides.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: tidepool FILE.csv");
  process.exit(2);
}
const readings = parse(readFileSync(file, "utf8"));
const { highs, lows } = turningPoints(readings);
for (const h of highs) console.log(`high water  ${String(h.hour).padStart(2, "0")}:00  ${h.height.toFixed(2)} m`);
for (const l of lows) console.log(`low water   ${String(l.hour).padStart(2, "0")}:00  ${l.height.toFixed(2)} m`);
console.log(`range       ${range(readings).toFixed(2)} m`);
