import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JobStore, isTerminal, toView } from "../src/core/jobs.js";

let stateDir: string;
let previous: string | undefined;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "ccas-jobs-"));
  previous = process.env["QODER_AS_SUBAGENT_STATE_DIR"];
  process.env["QODER_AS_SUBAGENT_STATE_DIR"] = stateDir;
});

afterEach(() => {
  if (previous === undefined) delete process.env["QODER_AS_SUBAGENT_STATE_DIR"];
  else process.env["QODER_AS_SUBAGENT_STATE_DIR"] = previous;
  rmSync(stateDir, { recursive: true, force: true });
});

function newJob(store: JobStore) {
  return store.create({
    sessionId: randomUUID(),
    tier: "consult",
    workspace: process.cwd(),
    prompt: "review the diff",
  });
}

describe("JobStore", () => {
  it("creates a running job with a random id", () => {
    const { store } = JobStore.open();
    const job = newJob(store);
    expect(job.status).toBe("running");
    expect(job.jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(store.require(job.jobId).sessionId).toBe(job.sessionId);
  });

  it("refuses an unknown job id instead of creating one", () => {
    // Possession of a handle is not authentication, and an unknown id must not
    // become a new job.
    const { store } = JobStore.open();
    expect(() => store.require(randomUUID())).toThrow(/unknown job id/);
    expect(store.list()).toHaveLength(0);
  });

  it("never persists the full prompt", () => {
    const { store } = JobStore.open();
    // Longer than the preview cap, with a marker that must not survive.
    const secret = "S".repeat(500) + "TAIL_MARKER";
    const job = store.create({
      sessionId: randomUUID(),
      tier: "consult",
      workspace: process.cwd(),
      prompt: secret,
    });
    expect(job.promptPreview).not.toContain("TAIL_MARKER");
    expect(job.promptPreview.length).toBeLessThan(secret.length);

    // The on-disk record must not carry it either.
    const onDisk = readFileSync(join(store.directory, `${job.jobId}.json`), "utf8");
    expect(onDisk).not.toContain("TAIL_MARKER");
  });

  it("hands out events by sequence number, and only the unseen ones", () => {
    const { store } = JobStore.open();
    const job = newJob(store);
    for (let i = 1; i <= 5; i += 1) store.append(job, { type: "note", text: `n${i}` });

    const first = store.readEvents(job, 0);
    expect(first.events.map((e) => e.text)).toEqual(["n1", "n2", "n3", "n4", "n5"]);
    expect(first.cursor).toBe(5);

    store.append(job, { type: "note", text: "n6" });
    const second = store.readEvents(job, first.cursor);
    expect(second.events.map((e) => e.text)).toEqual(["n6"]);
    expect(second.cursor).toBe(6);
  });

  it("tells the caller where the log restarts instead of skipping events", () => {
    const { store } = JobStore.open();
    const job = newJob(store);
    // Push past the compaction threshold so the oldest events are dropped.
    for (let i = 0; i < 2_100; i += 1) store.append(job, { type: "note", text: `n${i}` });

    const result = store.readEvents(job, 1); // a cursor from long ago
    expect(result.cursorResetTo).toBeDefined();
    expect(result.cursorResetTo!).toBeGreaterThan(1);
    expect(result.events.length).toBeGreaterThan(0);
  });

  it("records a terminal outcome and truncates an oversized result", () => {
    const { store } = JobStore.open();
    const job = newJob(store);
    store.finish(job, { status: "completed", result: "x".repeat(300 * 1024), exitCode: 0 });

    expect(job.status).toBe("completed");
    expect(job.resultTruncated).toBe(true);
    expect(job.result!.length).toBeLessThan(300 * 1024);
    expect(isTerminal(job.status)).toBe(true);
  });

  it("bounds and trims permission denial text", () => {
    const { store } = JobStore.open();
    const job = newJob(store);
    store.finish(job, {
      status: "completed",
      permissionDenials: Array.from({ length: 200 }, () => "y".repeat(500)),
    });
    expect(job.permissionDenials).toHaveLength(64);
    expect(job.permissionDenials![0]!.length).toBeLessThanOrEqual(201);
  });

  it("marks a job left running by a dead bridge as interrupted, keeping its session", () => {
    const sessionId = randomUUID();
    const first = JobStore.open().store;
    const job = first.create({
      sessionId,
      tier: "consult",
      workspace: process.cwd(),
      prompt: "long running",
    });

    // A new process opens the same state directory.
    const second = JobStore.open();
    expect(second.interrupted).toContain(job.jobId);

    const recovered = second.store.require(job.jobId);
    expect(recovered.status).toBe("interrupted");
    expect(recovered.error).toMatch(/bridge process exited/);
    // The session id survives, which is what makes a deliberate resume possible.
    expect(recovered.sessionId).toBe(sessionId);
  });

  it("leaves finished jobs alone across a restart", () => {
    const first = JobStore.open().store;
    const job = newJob(first);
    first.finish(job, { status: "completed", result: "done", exitCode: 0 });

    const second = JobStore.open();
    expect(second.interrupted).not.toContain(job.jobId);
    expect(second.store.require(job.jobId).status).toBe("completed");
  });

  it("ignores a corrupt record rather than failing to open", () => {
    const first = JobStore.open().store;
    const good = newJob(first);
    first.finish(good, { status: "completed", result: "done", exitCode: 0 });
    writeFileSync(join(first.directory, "not-a-job.json"), "{ this is not json", "utf8");
    writeFileSync(join(first.directory, "wrong-id.json"), JSON.stringify({ version: 1, jobId: "other" }), "utf8");

    const second = JobStore.open();
    expect(second.store.require(good.jobId).status).toBe("completed");
  });

  it("keeps concurrent jobs' event logs separate", () => {
    const { store } = JobStore.open();
    const jobs = Array.from({ length: 8 }, () => newJob(store));

    // Interleave appends across every job, the way concurrent runs would.
    for (let round = 0; round < 25; round += 1) {
      for (const [index, job] of jobs.entries()) {
        store.append(job, { type: "note", text: `job${index}-round${round}` });
      }
    }

    for (const [index, job] of jobs.entries()) {
      const { events } = store.readEvents(job, 0);
      expect(events).toHaveLength(25);
      // Every event belongs to this job and no other.
      for (const event of events) {
        expect(event.text).toMatch(new RegExp(`^job${index}-round`));
      }
      expect(events.at(-1)?.seq).toBe(25);
    }

    // Ids are distinct, so a handle can never resolve to the wrong job.
    expect(new Set(jobs.map((j) => j.jobId)).size).toBe(jobs.length);
  });

  it("exposes a view without the internal ownership fields", () => {
    const { store } = JobStore.open();
    const job = newJob(store);
    const view = toView(job) as Record<string, unknown>;
    expect(view).not.toHaveProperty("ownerBridgeId");
    expect(view).not.toHaveProperty("promptPreview");
    expect(view["jobId"]).toBe(job.jobId);
  });
});
