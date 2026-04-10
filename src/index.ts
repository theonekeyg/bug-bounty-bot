/**
 * Entry point for headless mode.
 * Usage: bun start --brief briefs/target.md [--boxer http://localhost:8080] [--db ./bugbounty.db]
 */

import { parseArgs } from "util";
import { existsSync } from "fs";
import { BoxerClient } from "./sandbox/boxer.js";
import { runOrchestrator } from "./orchestrator/agent.js";
import { DEFAULT_MODEL } from "./types/provider.js";
import { initDb } from "./db/index.js";

const { values } = parseArgs({
  options: {
    brief: { type: "string" },
    boxer: { type: "string", default: "http://localhost:8080" },
    db: { type: "string", default: "./bugbounty.db" },
  },
});

if (!values.brief) {
  console.error("Usage: bun start --brief <path-to-brief.md> [--boxer <boxer-url>] [--db <db-path>]");
  process.exit(1);
}

if (!existsSync(values.brief)) {
  console.error(`Brief not found: ${values.brief}`);
  process.exit(1);
}

const boxer = new BoxerClient(values.boxer);

console.log(`Starting Ralph Loop`);
console.log(`Brief:  ${values.brief}`);
console.log(`Boxer:  ${values.boxer}`);
console.log(`DB:     ${values.db}`);
console.log("─".repeat(60));

await initDb(values.db);

runOrchestrator(values.brief, boxer, { model: DEFAULT_MODEL, maxTracks: 6 }).catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
