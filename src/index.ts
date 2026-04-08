/**
 * Entry point for headless mode.
 * Usage: pnpm start --brief briefs/target.md [--boxer http://localhost:8080]
 */

import { parseArgs } from "util";
import { existsSync } from "fs";
import { BoxerClient } from "./sandbox/boxer.js";
import { runOrchestrator } from "./orchestrator/agent.js";

const { values } = parseArgs({
  options: {
    brief: { type: "string" },
    boxer: { type: "string", default: "http://localhost:8080" },
  },
});

if (!values.brief) {
  console.error("Usage: pnpm start --brief <path-to-brief.md> [--boxer <boxer-url>]");
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
console.log("─".repeat(60));

runOrchestrator(values.brief, boxer).catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
