/**
 * Job records: the state machine, the event log, and crash recovery.
 *
 * Three decisions worth stating outright:
 *
 *  - **A job id is a capability.** Unknown ids are refused, never created on
 *    first sight. MCP's security guidance is explicit that possession of a
 *    state handle is not authentication, so ids are random v4 UUIDs and every
 *    read is scoped to this bridge instance.
 *
 *  - **A job that was running when the bridge died is `interrupted`, not
 *    `failed`.** The child may well still be running, and the CLI's own
 *    transcript is the authority on whether the session can continue — not
 *    our PID table, which Windows reuses. `interrupted` keeps the session id
 *    so the caller can resume deliberately.
 *
 *  - **The event log is appended to, not rewritten.** A long run emits
 *    thousands of events; re-reading and re-writing the whole log per event is
 *    quadratic and would dominate the process. Appends are O(1) and the log is
 *    only rewritten when it needs compacting.
 */

import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { Tier } from "./policy.js";
import { assertNotReparsePoint, ensureStatePaths, type StatePaths } from "./state-dir.js";

export type JobStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface JobEvent {
  readonly seq: number;
  readonly at: number;
  readonly type: string;
  readonly text?: string;
}

export interface JobRecord {
  version: 1;
  jobId: string;
  /** Which bridge process created it. A different id means a previous run. */
  ownerBridgeId: string;
  sessionId: string;
  tier: Tier;
  workspace: string;
  /** Truncated for identification only; the full prompt is never persisted. */
  promptPreview: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** Diagnostic only. Never used to infer liveness after a restart. */
  pid?: number;
  exitCode?: number | null;
  result?: string;
  resultTruncated?: boolean;
  permissionDenials?: string[];
  error?: string;
  /** Number of events ever appended; the cursor space is [1, eventCount]. */
  eventCount: number;
  /** Oldest event still retained. A cursor below this has been evicted. */
  firstRetainedSeq: number;
}

export interface StatusView {
  jobId: string;
  sessionId: string;
  status: JobStatus;
  tier: Tier;
  workspace: string;
  createdAt: number;
  updatedAt: number;
  result?: string;
  resultTruncated?: boolean;
  permissionDenials?: string[];
  error?: string;
  exitCode?: number | null;
}

const PROMPT_PREVIEW_CHARS = 200;
const MAX_RESULT_CHARS = 256 * 1024;
const MAX_PERMISSION_DENIALS = 64;
const MAX_EVENTS = 1_000;
const COMPACT_AT = MAX_EVENTS * 2;
/** Cap on events returned by a single poll, regardless of how far behind. */
const MAX_EVENTS_PER_READ = 200;

/** Terminal states never change again. */
export function isTerminal(status: JobStatus): boolean {
  return status !== "running";
}

function eventsPath(paths: StatePaths, jobId: string): string {
  return join(paths.jobsDir, `${jobId}.events.ndjson`);
}

function recordPath(paths: StatePaths, jobId: string): string {
  return join(paths.jobsDir, `${jobId}.json`);
}

/** Write via a sibling temp file and rename, so a crash cannot tear the file. */
function writeAtomic(target: string, contents: string): void {
  assertNotReparsePoint(target);
  const temp = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temp, contents, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, target);
}

function loadEventLog(paths: StatePaths, jobId: string): JobEvent[] {
  let raw: string;
  try {
    raw = readFileSync(eventsPath(paths, jobId), "utf8");
  } catch {
    return [];
  }
  const events: JobEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as JobEvent;
      if (typeof parsed?.seq === "number") events.push(parsed);
    } catch {
      // A torn final line is possible after a crash; everything before it is
      // still good, so skip it rather than discard the log.
    }
  }
  return events;
}

export class JobStore {
  private readonly paths: StatePaths;
  private readonly bridgeId = randomUUID();
  private readonly cache = new Map<string, JobRecord>();
  private readonly events = new Map<string, JobEvent[]>();

  private constructor(paths: StatePaths) {
    this.paths = paths;
  }

  /**
   * Open the store and age out anything left running by a previous bridge
   * process. Their session ids survive so a caller can resume.
   */
  static open(): { store: JobStore; interrupted: string[] } {
    const store = new JobStore(ensureStatePaths());
    const interrupted: string[] = [];

    let names: string[];
    try {
      names = readdirSync(store.paths.jobsDir);
    } catch {
      return { store, interrupted };
    }

    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const jobId = name.slice(0, -".json".length);
      let record: JobRecord;
      try {
        record = JSON.parse(readFileSync(join(store.paths.jobsDir, name), "utf8")) as JobRecord;
      } catch {
        continue; // unreadable record: skip it, do not fail the whole open
      }
      if (record?.version !== 1 || record.jobId !== jobId) continue;

      if (!isTerminal(record.status) && record.ownerBridgeId !== store.bridgeId) {
        // The bridge that owned this is gone. We cannot tell whether the child
        // survived, so do not claim either way.
        record.status = "interrupted";
        record.updatedAt = Date.now();
        record.error =
          "the bridge process exited while this job was running; " +
          "resume the session to continue";
        store.persist(record);
        interrupted.push(jobId);
      }
      store.cache.set(jobId, record);
      store.events.set(jobId, loadEventLog(store.paths, jobId));
    }

    return { store, interrupted };
  }

  get id(): string {
    return this.bridgeId;
  }

  private persist(record: JobRecord): void {
    writeAtomic(recordPath(this.paths, record.jobId), JSON.stringify(record, null, 2));
  }

  private logOf(jobId: string): JobEvent[] {
    let log = this.events.get(jobId);
    if (log === undefined) {
      log = loadEventLog(this.paths, jobId);
      this.events.set(jobId, log);
    }
    return log;
  }

  create(input: {
    sessionId: string;
    tier: Tier;
    workspace: string;
    prompt: string;
  }): JobRecord {
    const now = Date.now();
    const record: JobRecord = {
      version: 1,
      jobId: randomUUID(),
      ownerBridgeId: this.bridgeId,
      sessionId: input.sessionId,
      tier: input.tier,
      workspace: input.workspace,
      promptPreview:
        input.prompt.length > PROMPT_PREVIEW_CHARS
          ? input.prompt.slice(0, PROMPT_PREVIEW_CHARS) + "…"
          : input.prompt,
      status: "running",
      createdAt: now,
      updatedAt: now,
      eventCount: 0,
      firstRetainedSeq: 1,
    };
    this.cache.set(record.jobId, record);
    this.events.set(record.jobId, []);
    this.persist(record);
    writeAtomic(eventsPath(this.paths, record.jobId), "");
    return record;
  }

  /**
   * Look up a job. A well-formed id that we do not know is an error — never a
   * reason to create one.
   */
  require(jobId: string): JobRecord {
    const record = this.cache.get(jobId);
    if (record === undefined) {
      throw new Error(`unknown job id: ${jobId}`);
    }
    if (record.ownerBridgeId !== this.bridgeId && !isTerminal(record.status)) {
      throw new Error(`job ${jobId} is owned by another bridge process`);
    }
    return record;
  }

  has(jobId: string): boolean {
    return this.cache.has(jobId);
  }

  /** All jobs, newest first. */
  list(): JobRecord[] {
    return [...this.cache.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  append(record: JobRecord, event: Omit<JobEvent, "seq" | "at">): JobEvent {
    const seq = record.eventCount + 1;
    const full: JobEvent = { seq, at: Date.now(), ...event };
    const log = this.logOf(record.jobId);

    log.push(full);
    appendFileSync(eventsPath(this.paths, record.jobId), JSON.stringify(full) + "\n");
    record.eventCount = seq;

    if (log.length > COMPACT_AT) {
      // Drop the oldest, then rewrite once. Amortised O(1) per event.
      log.splice(0, log.length - MAX_EVENTS);
      writeAtomic(
        eventsPath(this.paths, record.jobId),
        log.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
    }

    record.firstRetainedSeq = log[0]?.seq ?? seq;
    record.updatedAt = full.at;
    this.persist(record);
    return full;
  }

  update(record: JobRecord, patch: Partial<JobRecord>): void {
    Object.assign(record, patch, { updatedAt: Date.now() });
    this.persist(record);
  }

  finish(
    record: JobRecord,
    outcome: {
      status: Extract<JobStatus, "completed" | "failed" | "cancelled">;
      result?: string;
      resultTruncated?: boolean;
      permissionDenials?: readonly string[];
      error?: string;
      exitCode?: number | null;
    },
  ): void {
    const finishedAt = Date.now();
    record.status = outcome.status;
    record.finishedAt = finishedAt;
    record.exitCode = outcome.exitCode ?? null;

    if (outcome.result !== undefined) {
      if (outcome.result.length > MAX_RESULT_CHARS) {
        record.result = outcome.result.slice(0, MAX_RESULT_CHARS);
        record.resultTruncated = true;
      } else {
        record.result = outcome.result;
        record.resultTruncated = false;
      }
    }
    if (outcome.permissionDenials !== undefined) {
      // Denial text is written by the model and can carry attacker-influenced
      // command strings. Keep it short and bounded.
      record.permissionDenials = outcome.permissionDenials
        .slice(0, MAX_PERMISSION_DENIALS)
        .map((d) => (d.length > 200 ? d.slice(0, 200) + "…" : d));
    }
    if (outcome.error !== undefined) record.error = outcome.error;

    record.updatedAt = finishedAt;
    this.persist(record);
  }

  /**
   * Events after `cursor`, plus the cursor to send back.
   *
   * The cursor is an event *sequence number*, not a byte offset: an offset into
   * an append-only file silently lands mid-record once the log is compacted.
   */
  readEvents(
    record: JobRecord,
    cursor: number,
  ): { events: JobEvent[]; cursor: number; cursorResetTo?: number } {
    const log = this.logOf(record.jobId);
    const oldest = log[0]?.seq ?? record.eventCount + 1;

    if (cursor > 0 && cursor < oldest - 1) {
      // The caller fell behind a compaction; say where the log now starts
      // instead of silently skipping events.
      const fresh = log.slice(-MAX_EVENTS_PER_READ);
      return {
        events: fresh,
        cursor: fresh.at(-1)?.seq ?? cursor,
        cursorResetTo: oldest,
      };
    }

    const fresh = log.filter((e) => e.seq > cursor).slice(0, MAX_EVENTS_PER_READ);
    return { events: fresh, cursor: fresh.at(-1)?.seq ?? cursor };
  }

  /** Remove a job's files. Used by tests; the server never deletes history. */
  purge(jobId: string): void {
    this.cache.delete(jobId);
    this.events.delete(jobId);
    rmSync(recordPath(this.paths, jobId), { force: true });
    rmSync(eventsPath(this.paths, jobId), { force: true });
  }

  get directory(): string {
    return this.paths.jobsDir;
  }
}

export function toView(record: JobRecord): StatusView {
  const view: StatusView = {
    jobId: record.jobId,
    sessionId: record.sessionId,
    status: record.status,
    tier: record.tier,
    workspace: record.workspace,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (record.result !== undefined) view.result = record.result;
  if (record.resultTruncated !== undefined) view.resultTruncated = record.resultTruncated;
  if (record.permissionDenials !== undefined) {
    view.permissionDenials = record.permissionDenials;
  }
  if (record.error !== undefined) view.error = record.error;
  if (record.exitCode !== undefined) view.exitCode = record.exitCode;
  return view;
}
