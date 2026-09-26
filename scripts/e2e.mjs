/**
 * End-to-end: drive the built server over stdio and check the behaviour that
 * only shows up when the pieces run together.
 *
 * The load-bearing assertions:
 *
 *  - a `consult` run reads but cannot write;
 *  - a resumed turn still carries the isolation stack. `--resume` restores none
 *    of `--tools`, `--settings` or `--setting-sources`, so a resume path that
 *    built its own command line would run unconfined and look entirely normal.
 *    The check reads the tool list back off the session's own init event.
 *  - a workspace outside the configured roots is refused.
 *
 * Spawns real model calls.
 *
 *   node scripts/e2e.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../dist/index.js");

const workspace = mkdtempSync(join(tmpdir(), "ccas-e2e-"));
const outside = mkdtempSync(join(tmpdir(), "ccas-e2e-outside-"));
const stateDir = mkdtempSync(join(tmpdir(), "ccas-e2e-state-"));

writeFileSync(join(workspace, "hello.txt"), "the magic word is ORANGE-OTTER\n");
mkdirSync(join(workspace, "sub"), { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}`);
  if (detail) console.log(`         ${detail}`);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  stderr: "pipe",
  env: {
    ...process.env,
    QODER_AS_SUBAGENT_WORKSPACE_ROOTS: workspace,
    QODER_AS_SUBAGENT_STATE_DIR: stateDir,
  },
});
transport.stderr?.on("data", (d) => {
  const s = String(d).trim();
  if (s) process.stderr.write(`  [server] ${s}\n`);
});

const client = new Client({ name: "e2e", version: "0.0.0" });

/** Call a tool and unwrap its structured payload. */
async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const payload = res.structuredContent ?? JSON.parse(res.content?.[0]?.text ?? "{}");
  return { payload, isError: res.isError === true };
}

/** Submit and poll to completion. */
async function runToCompletion(args, { maxPolls = 60 } = {}) {
  const start = await call("qoder_run", args);
  if (start.isError) return { start, record: null };
  let jobId = start.payload.jobId;
  for (let i = 0; i < maxPolls; i += 1) {
    const status = await call("qoder_status", { jobId, waitSeconds: 15 });
    const s = status.payload.status;
    if (s !== "running") return { start, record: status.payload, jobId };
    jobId = status.payload.jobId ?? jobId;
  }
  return { start, record: null, jobId };
}

try {
  await client.connect(transport);

  // ---------------------------------------------------------------- refusal
  {
    const res = await call("qoder_run", {
      tier: "consult",
      prompt: "say ok",
      workspace: outside,
    });
    check(
      "refuses a workspace outside the allowed roots",
      res.isError && /outside every allowed root/.test(res.payload.error ?? ""),
      res.payload.error,
    );
  }

  {
    const res = await call("qoder_run", {
      tier: "consult",
      prompt: "say ok",
      workspace: "\\\\server\\share",
    });
    check(
      "refuses a network path",
      res.isError && /network path/.test(res.payload.error ?? ""),
      res.payload.error,
    );
  }

  {
    const res = await call("qoder_status", { jobId: "00000000-0000-4000-8000-000000000000" });
    check("refuses an unknown job id", res.isError && /unknown job id/.test(res.payload.error ?? ""));
  }

  // ------------------------------------------------------- consult: read-only
  let consultJobId;
  let consultSessionId;
  {
    // One task per run. Asking the model to read *and* to probe its own write
    // access makes it abandon both when the second half fails, which tests the
    // prompt rather than the policy.
    const { record, jobId } = await runToCompletion({
      tier: "consult",
      prompt: "Read hello.txt and reply with exactly the magic word it contains.",
      workspace,
      model: "auto",
    });
    consultJobId = jobId;
    consultSessionId = record?.sessionId;

    check(
      "consult run completes",
      record?.status === "completed",
      record ? `status=${record.status} error=${record.error ?? "-"}` : "no record",
    );
    check(
      "consult run reads the workspace",
      typeof record?.result === "string" && record.result.includes("ORANGE-OTTER"),
      (record?.result ?? "").slice(0, 900),
    );

    if (process.env["CCAS_E2E_DEBUG"] === "1") {
      const full = await call("qoder_status", { jobId, cursor: 0 });
      console.log("         --- events ---");
      for (const e of full.payload.events ?? []) {
        console.log(`         ${e.seq} ${e.type}: ${String(e.text ?? "").slice(0, 400)}`);
      }
      console.log(`         --- denials: ${JSON.stringify(full.payload.permissionDenials)}`);
      console.log(`         --- workspace: ${full.payload.workspace}`);
      console.log(`         --- jobId: ${jobId}`);
    }

    // Write-impossibility is asserted structurally rather than by asking the
    // model to try: the tier simply does not grant a write tool, and the
    // session's own init event says so. That is deterministic.
    const status = await call("qoder_status", { jobId, cursor: 0 });
    const init = (status.payload.events ?? []).find((e) => e.type === "init");
    const toolsLine = init?.text ?? "";
    check(
      "consult session is granted no write tool",
      toolsLine.includes("tools=[") &&
        !toolsLine.includes("Write") &&
        !toolsLine.includes("Edit") &&
        !toolsLine.includes("Bash"),
      toolsLine || "no init event",
    );
  }

  // -------------------------------------------------- reply: isolation survives
  {
    const res = await call("qoder_reply", {
      jobId: consultJobId,
      prompt: "Name the file you read, and nothing else.",
      waitSeconds: 30,
    });
    check("reply is accepted", !res.isError, res.payload.error);

    const status = await call("qoder_status", { jobId: res.payload.jobId, waitSeconds: 30 });
    const record = status.payload;

    check(
      "resumed turn completes",
      record.status === "completed",
      `status=${record.status} error=${record.error ?? "-"}`,
    );
    check(
      "resumed turn keeps the same session",
      record.sessionId === consultSessionId,
      `${record.sessionId} vs ${consultSessionId}`,
    );

    // The decisive check: read the tool list back off the resumed session's own
    // init event. If resume dropped --tools, this would show the full set.
    const events = await call("qoder_status", { jobId: res.payload.jobId, cursor: 0 });
    const init = (events.payload.events ?? []).find((e) => e.type === "init");
    const toolsLine = init?.text ?? "";
    const confined =
      toolsLine.includes("tools=[") &&
      !toolsLine.includes("Write") &&
      !toolsLine.includes("Bash");
    check(
      "resumed turn still carries the isolation stack",
      confined,
      toolsLine || "no init event found",
    );
  }

  // ------------------------------------------------------- execute: can write
  {
    const { record, jobId: executeJobId } = await runToCompletion({
      tier: "execute",
      prompt: "Create a file named made.txt containing exactly: OK",
      workspace,
      model: "auto",
    });
    check(
      "execute run completes",
      record?.status === "completed",
      `status=${record?.status} error=${record?.error ?? "-"}`,
    );
    let made = "";
    try {
      made = readFileSync(join(workspace, "made.txt"), "utf8").trim();
    } catch {
      /* absent */
    }
    // Only the first line is asserted. This CLI tells the model which tools were
    // denied, and the model may append that list to whatever it writes —
    // observed on 1.1.64, where a plain "write OK" produced the expected first
    // line followed by every denied tool name. The property under test is that
    // the tier can write at all, not that the model writes nothing else.
    check(
      "execute run writes inside the workspace",
      made.split(/\r?\n/)[0]?.trim() === "OK",
      JSON.stringify(made.slice(0, 160)),
    );

    // A tier grants exactly its set. 2.1.283 adds GetTask to a Bash-capable
    // session even when --tools does not name it, which is why policy.ts denies
    // it explicitly; this is the check that would notice if that stopped
    // working, or if the CLI started adding something else.
    const full = await call("qoder_status", { jobId: executeJobId, cursor: 0 });
    const init = (full.payload.events ?? []).find((e) => e.type === "init");
    const granted = (init?.text ?? "")
      .replace(/^.*tools=\[/, "")
      .replace(/\].*$/, "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .sort();
    const expected = ["Bash", "Edit", "Glob", "Grep", "Read", "Write"];
    check(
      "execute session is granted exactly the tier's tools",
      JSON.stringify(granted) === JSON.stringify(expected),
      `granted [${granted.join(", ")}]`,
    );
  }
} catch (error) {
  check("harness", false, error instanceof Error ? error.message : String(error));
} finally {
  await client.close().catch(() => {});
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
