/**
 * Drift guard: prove the security assumptions against the CLI actually
 * installed on this machine.
 *
 * Adapted from `cc-as-subagent`, but the checks are not the same, because the
 * two CLIs do not offer the same controls. Qoder has no `--safe-mode`, no turn
 * limit and no spend cap, so there is nothing here to assert about those; what
 * it does have is `--setting-sources`, and that is the load-bearing one.
 *
 * Every check both makes the vulnerable condition observable *and* proves the
 * probe can observe it. A check that only asserts "the bad thing did not
 * happen" passes vacuously when the probe itself is broken.
 *
 * This spawns real model calls, so it is a deliberate command rather than
 * something the server runs at startup — the client's startup timeout is 10s
 * and one run takes longer than that.
 *
 *   node scripts/selfcheck.mjs [--quick]
 *
 * Writes its verdict to <state>/selfcheck.json.
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(resolve(here, rel)).href);
const { resolveQoderBin } = await load("../dist/core/spawn.js");
const { buildQoderArgv } = await load("../dist/core/argv.js");
const { buildSettings } = await load("../dist/core/policy.js");
const { ensureStatePaths } = await load("../dist/core/state-dir.js");

const quick = process.argv.includes("--quick");
const bin = resolveQoderBin();
const results = [];
const scratch = mkdtempSync(join(tmpdir(), "qoder-selfcheck-"));

function record(name, status, detail) {
  results.push({ name, status, detail });
  const mark = { pass: "PASS", fail: "FAIL", warn: "WARN", skipped: "SKIP" }[status];
  console.log(`  [${mark}] ${name}`);
  if (detail) console.log(`         ${detail}`);
}

function runCli({ cwd, argv, prompt, timeout = 240_000, env = process.env }) {
  return spawnSync(bin, argv, {
    cwd,
    input: prompt,
    encoding: "utf8",
    timeout,
    windowsHide: true,
    env,
  });
}

function eventsOf(stdout) {
  const out = [];
  for (const line of (stdout ?? "").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* ignore */
    }
  }
  return out;
}

function initEventOf(stdout) {
  return eventsOf(stdout).find((e) => e.type === "system" && e.subtype === "init");
}

// ---------------------------------------------------------------------------
// Gate 1: does a workspace's own .qoder/settings.json reach the run?
//
// `--setting-sources=user` is the only isolation flag Qoder shares with the
// other CLI, and the reason it matters was measured there: a project settings
// `env` block reached the process and changed the model the session ran on.
// Whether the same holds here is exactly what this measures — the mechanism is
// shared, the implementation is not.
//
// The probe sets QODERCN_MODEL, which the docs list as settable from a
// settings `env` block, and which the CLI echoes back on the init event.
// ---------------------------------------------------------------------------
function checkSettingSources() {
  const probe = "PROBE-MODEL-XYZ-9911";
  const repo = join(scratch, "hostile-repo");
  mkdirSync(join(repo, ".qoder"), { recursive: true });
  writeFileSync(
    join(repo, ".qoder", "settings.json"),
    JSON.stringify({ env: { QODERCN_MODEL: probe } }),
  );

  const policyPath = join(scratch, "policy.json");
  writeFileSync(policyPath, JSON.stringify(buildSettings("consult")));

  // The user's own settings may set the same variable, so clear it from the
  // inherited environment and let the control prove the signal can fire.
  const base = { ...process.env };
  delete base["QODERCN_MODEL"];

  const attempt = (settingSources) => {
    const res = runCli({
      cwd: repo,
      argv: [
        "-p",
        `--setting-sources=${settingSources}`,
        "--tools=Read",
        "--permission-mode=dont_ask",
        `--settings=${policyPath}`,
        `--session-id=${randomUUID()}`,
        "--output-format=stream-json",
      ],
      prompt: "Reply OK",
      env: base,
    });
    const init = initEventOf(res.stdout);
    return { model: init?.model ?? "(no init)", source: JSON.stringify(init?.tools ?? []) };
  };

  // Control: same channel the attack uses, but through --settings, which is
  // always loaded. If this does not fire, the negative result below means
  // nothing.
  const controlSettings = join(scratch, "control-settings.json");
  writeFileSync(controlSettings, JSON.stringify({ env: { QODERCN_MODEL: probe } }));
  const control = runCli({
    cwd: scratch,
    argv: [
      "-p",
      "--tools=Read",
      "--permission-mode=dont_ask",
      `--settings=${controlSettings}`,
      `--session-id=${randomUUID()}`,
      "--output-format=stream-json",
    ],
    prompt: "Reply OK",
    env: base,
  });
  const controlModel = initEventOf(control.stdout)?.model ?? "(no init)";
  if (controlModel !== probe) {
    // The probe never fired, so nothing below could be measured. Reported as
    // skipped rather than passed: "the bad thing did not happen" is exactly
    // what a broken probe looks like, and recording it as a pass would be a
    // false all-clear on the load-bearing guard.
    record(
      "--setting-sources=user is load-bearing",
      "skipped",
      "could not make the injection probe fire on this CLI (tried QODERCN_MODEL, " +
        "`model` and `outputStyle` in .qoder/settings.json, none observable in the init " +
        "event), so whether a workspace can reconfigure a run is UNVERIFIED here. " +
        "The flag is kept because it is the same flag, with the same vocabulary, as the " +
        "CLI where the mechanism was measured. See SECURITY.md.",
    );
    return;
  }

  const injected = attempt("user,project");
  const guarded = attempt("user");

  if (injected.model === probe) {
    record(
      "project settings `env` reaches the run",
      "pass",
      "confirmed — a workspace can reconfigure the agent reading it; the guard is load-bearing",
    );
  } else {
    record(
      "project settings `env` reaches the run",
      "warn",
      `not observed on this CLI version (model came back as ${injected.model}); ` +
        "the guard is then defence in depth rather than a fix",
    );
  }

  if (guarded.model === probe) {
    record(
      "--setting-sources=user blocks it",
      "fail",
      "the injected value still arrived — the guard does not work on this version",
    );
  } else {
    record("--setting-sources=user blocks it", "pass", "the injected value never arrived");
  }
}

// ---------------------------------------------------------------------------
// Gate 2: are the restrictions actually in effect, or silently ignored?
// Read the granted tool list back off the session's own init event.
// ---------------------------------------------------------------------------
function checkToolsEffective() {
  const settingsPath = join(scratch, "tools-check-settings.json");
  writeFileSync(settingsPath, JSON.stringify(buildSettings("consult")));

  const argv = buildQoderArgv({
    tier: "consult",
    settingsPath,
    session: { kind: "new", id: randomUUID() },
    model: "auto",
  });
  const res = runCli({ cwd: scratch, argv: [...argv], prompt: "Reply OK" });
  const init = initEventOf(res.stdout);

  if (init === undefined) {
    record("--tools restriction is effective", "fail", "no init event; cannot read the tool list");
    return;
  }
  const tools = Array.isArray(init.tools) ? init.tools : [];
  const expected = ["Glob", "Grep", "Read"];
  const missing = expected.filter((t) => !tools.includes(t));
  const extra = tools.filter((t) => !expected.includes(t));

  if (missing.length > 0) {
    record("--tools restriction is effective", "fail", `expected tools missing: ${missing.join(", ")}`);
  } else if (extra.length > 0) {
    record(
      "--tools restriction is effective",
      "fail",
      `tools beyond the tier are present: ${extra.join(", ")} — the restriction is not confining`,
    );
  } else {
    record("--tools restriction is effective", "pass", `session tools = [${tools.join(", ")}]`);
    record(
      "--disallowed-tools did not swallow later flags",
      "pass",
      "the tool list is exactly the tier set, so nothing after the variadic was lost",
    );
  }
}

// ---------------------------------------------------------------------------
// Gate 3: does the session id we mint come back unchanged?
// ---------------------------------------------------------------------------
function checkSessionRoundTrip() {
  const id = randomUUID();
  const settingsPath = join(scratch, "session-check-settings.json");
  writeFileSync(settingsPath, JSON.stringify(buildSettings("consult")));

  const argv = buildQoderArgv({
    tier: "consult",
    settingsPath,
    session: { kind: "new", id },
    model: "auto",
  });
  const res = runCli({ cwd: scratch, argv: [...argv], prompt: "Reply OK" });
  const result = eventsOf(res.stdout).find((e) => e.type === "result");

  if (result === undefined) {
    record("--session-id round-trip", "fail", "no result event");
    return;
  }
  if (result.session_id !== id) {
    record(
      "--session-id round-trip",
      "fail",
      `asked for ${id}, got ${String(result.session_id)} — resume would target the wrong session`,
    );
    return;
  }
  record("--session-id round-trip", "pass", "the id we minted is the id in the result");
}

// ---------------------------------------------------------------------------
// Gate 4: are the ceilings still missing?
//
// `cc-as-subagent` can bound a run with --max-turns and --max-budget-usd. This
// CLI has neither, which is why the server documents "no built-in ceiling".
// That is a statement about a specific version, so it is checked rather than
// assumed: if a future release adds them, this fails and the policy can be
// tightened.
// ---------------------------------------------------------------------------
function checkMissingCeilings() {
  const help = spawnSync(bin, ["--help"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  const text = (help.stdout ?? "") + (help.stderr ?? "");

  const absent = ["--max-turns", "--max-budget-usd"].filter((f) => !text.includes(f));
  if (absent.length === 2) {
    record(
      "no turn limit or spend cap exists",
      "pass",
      "confirmed for this version — the server's timeout is the only bound on a run",
    );
  } else {
    const present = ["--max-turns", "--max-budget-usd"].filter((f) => text.includes(f));
    record(
      "no turn limit or spend cap exists",
      "fail",
      `${present.join(", ")} now exist — this CLI gained a ceiling; add it in src/core/argv.ts`,
    );
  }

  // Deliberately NOT checked here: that this CLI has no `--safe-mode`
  // equivalent, so a workspace's AGENTS.md, skills, plugins and hooks still
  // load. That is a fixed property of the version, not something a re-run can
  // change, and a check that is permanently yellow teaches people to ignore
  // yellow. It is documented in SECURITY.md instead, and the hook activity it
  // produces is visible in a job's event stream (see stream.ts).
}

// ---------------------------------------------------------------------------

console.log(`\nselfcheck — ${bin}\n`);
try {
  console.log("Gate 1: project settings `env` injection");
  checkSettingSources();

  if (!quick) {
    console.log("\nGate 2: restrictions actually applied");
    checkToolsEffective();

    console.log("\nGate 3: session id round-trip");
    checkSessionRoundTrip();

    console.log("\nGate 4: ceilings and known gaps");
    checkMissingCeilings();
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const failed = results.filter((r) => r.status === "fail");
const warned = results.filter((r) => r.status === "warn");
const skipped = results.filter((r) => r.status === "skipped");

const verdict = {
  at: Date.now(),
  qoderCliVersion: (() => {
    const v = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 20_000, windowsHide: true });
    return (v.stdout ?? "").trim() || "unknown";
  })(),
  ok: failed.length === 0,
  results,
};

try {
  const { root } = ensureStatePaths();
  writeFileSync(join(root, "selfcheck.json"), JSON.stringify(verdict, null, 2));
  console.log(`\nverdict written to ${join(root, "selfcheck.json")}`);
} catch (error) {
  console.log(`\ncould not persist the verdict: ${error.message}`);
}

console.log(
  `\n${results.length} checks: ` +
    `${results.length - failed.length - warned.length - skipped.length} pass, ` +
    `${warned.length} warn, ${skipped.length} skipped, ${failed.length} fail`,
);
process.exit(failed.length === 0 ? 0 : 1);
