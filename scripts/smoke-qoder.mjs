/**
 * Validate the generated argv against the real CLI.
 *
 * The unit tests prove the command line has the right *shape*; only running it
 * proves the CLI *accepts* that shape. A flag spelling the CLI rejects would
 * otherwise fail every job at runtime, long after the argv module looked fine.
 *
 * Costs one short model call. Uses a fixed prompt with a fixed answer so a
 * success is unambiguous.
 *
 *   node scripts/smoke-qoder.mjs [--tier consult|execute]
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
// Absolute paths must be file:// URLs for the ESM loader on Windows.
const load = (relative) => import(pathToFileURL(resolve(here, relative)).href);

const { buildQoderArgv } = await load("../dist/core/argv.js");
const { buildSettings } = await load("../dist/core/policy.js");
const { resolveQoderBin } = await load("../dist/core/spawn.js");

const tierArg = process.argv.indexOf("--tier");
const tier = tierArg === -1 ? "consult" : process.argv[tierArg + 1];
if (tier !== "consult" && tier !== "execute") {
  console.error(`unknown tier: ${tier}`);
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), "ccas-smoke-"));
const settingsPath = join(scratch, "settings.json");
writeFileSync(settingsPath, JSON.stringify(buildSettings(tier)), { mode: 0o600 });

const sessionId = randomUUID();
const argv = buildQoderArgv({
  tier,
  settingsPath,
  session: { kind: "new", id: sessionId },
  model: process.env["SMOKE_MODEL"] ?? "auto",
});

const bin = resolveQoderBin();
console.log(`  bin      ${bin}`);
console.log(`  tier     ${tier}`);
console.log(`  session  ${sessionId}`);
console.log(`  argv     ${argv.length} tokens`);
for (const token of argv) {
  const shown = token.length > 96 ? `${token.slice(0, 93)}...` : token;
  console.log(`      ${shown}`);
}

const prompt = "Reply with exactly: SMOKE_OK";
console.log(`\n  prompt   ${JSON.stringify(prompt)}  (via stdin)`);
console.log("  running...\n");

const started = Date.now();
const child = spawnSync(bin, argv, {
  input: prompt,
  encoding: "utf8",
  timeout: 180_000,
  windowsHide: true,
  env: process.env,
});
const elapsed = Date.now() - started;

rmSync(scratch, { recursive: true, force: true });

const stdout = child.stdout ?? "";
const stderr = child.stderr ?? "";
let sawResult = false;
let resultText = "";
let sawSessionId = "";
for (const line of stdout.split("\n")) {
  if (line.trim() === "") continue;
  try {
    const event = JSON.parse(line);
    if (event?.type === "result") {
      sawResult = true;
      resultText = typeof event.result === "string" ? event.result : "";
      sawSessionId = event.session_id ?? "";
    }
  } catch {
    /* not NDJSON; reported below */
  }
}

console.log(`  exit      ${child.status}  (${elapsed}ms)`);
console.log(`  result    ${sawResult ? "event seen" : "MISSING"}`);
console.log(`  answer    ${JSON.stringify(resultText.slice(0, 120))}`);
console.log(`  session   ${sawSessionId} ${sawSessionId === sessionId ? "(matches)" : "(MISMATCH)"}`);
if (stderr.trim()) console.log(`  stderr    ${stderr.trim().split("\n").slice(0, 4).join("\n            ")}`);

const ok = child.status === 0 && sawResult && sawSessionId === sessionId;
console.log(ok ? "\nPASS" : "\nFAIL");
process.exit(ok ? 0 : 1);
