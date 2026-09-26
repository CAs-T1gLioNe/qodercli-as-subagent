/**
 * Ties the pieces together: validate, create a job, build the command, run it,
 * and record the outcome.
 *
 * A submission never waits for an answer. The client's own tool timeout is 60s
 * by default, and a real review runs for minutes, so blocking inside a tool
 * call would guarantee transport timeouts. Callers poll instead.
 */

import { randomUUID } from "node:crypto";

import { buildQoderArgv, type SessionSpec } from "./argv.js";
import { sanitizeEnv } from "./env.js";
import { JobStore, type JobRecord } from "./jobs.js";
import { isTier, type Tier } from "./policy.js";
import { writeSettingsFile } from "./settings-file.js";
import { killTree, runQoder } from "./spawn.js";
import { describeMissingResult, StreamParser } from "./stream.js";
import { resolveWorkspace } from "./workspace.js";

/** Upper bound for a run. Long, but not unbounded. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** Ceiling on a blocking wait, kept well under a client's 60s tool timeout. */
export const MAX_WAIT_SECONDS = 45;

export interface StartInput {
  readonly tier: unknown;
  readonly prompt: unknown;
  readonly workspace: unknown;
  readonly model?: unknown;
  readonly reasoningEffort?: unknown;
  readonly maxOutputTokens?: unknown;
}

export interface StartResult {
  readonly jobId: string;
  readonly sessionId: string;
  readonly status: string;
  readonly tier: Tier;
  readonly workspace: string;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a number`);
  }
  if (value < min || value > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return value;
}

export class Runner {
  private readonly running = new Map<string, number>();

  constructor(private readonly store: JobStore) {}

  /**
   * Register a job and start it in the background.
   *
   * Returns as soon as the child is launched — not when it finishes.
   */
  start(input: StartInput): StartResult {
    if (!isTier(input.tier)) {
      throw new Error(`tier must be one of: consult, execute (got ${JSON.stringify(input.tier)})`);
    }
    const tier: Tier = input.tier;

    const prompt = optionalString(input.prompt, "prompt");
    if (prompt === undefined) throw new Error("prompt is required");

    // Throws for a workspace outside every allowed root, a network path, a
    // device path, a relative path, or one that does not exist.
    const workspace = resolveWorkspace(input.workspace);

    const model = optionalString(input.model, "model");
    const reasoningEffort = optionalString(input.reasoningEffort, "reasoningEffort");
    const maxOutputTokens = optionalNumber(input.maxOutputTokens, "maxOutputTokens", 1, 200_000);

    const sessionId = randomUUID();
    const record = this.store.create({ sessionId, tier, workspace, prompt });

    void this.execute(record, { kind: "new", id: sessionId }, prompt, {
      model,
      reasoningEffort,
      maxOutputTokens,
    });

    return {
      jobId: record.jobId,
      sessionId,
      status: record.status,
      tier,
      workspace,
    };
  }

  /**
   * Continue an existing session.
   *
   * Takes a job id, never a session id. The session id is read from our own
   * registry, so a caller cannot aim `--resume` at an arbitrary transcript —
   * the flag also accepts a path, which would make it a file-read primitive.
   */
  resume(jobId: unknown): StartResult {
    const id = optionalString(jobId, "jobId");
    if (id === undefined) throw new Error("jobId is required");

    const previous = this.store.require(id);
    if (!this.store.has(previous.jobId)) throw new Error(`unknown job id: ${id}`);
    if (previous.status === "running") {
      throw new Error(`job ${id} is still running; wait for it before replying`);
    }
    if (previous.status === "cancelled") {
      throw new Error(`job ${id} was cancelled and its session cannot be continued`);
    }
    return {
      jobId: previous.jobId,
      sessionId: previous.sessionId,
      status: previous.status,
      tier: previous.tier,
      workspace: previous.workspace,
    };
  }

  /** Start a follow-up turn against the session owned by `jobId`. */
  reply(input: {
    jobId: unknown;
    prompt: unknown;
    model?: unknown;
    reasoningEffort?: unknown;
  }): StartResult {
    const previous = this.resume(input.jobId);
    const prompt = optionalString(input.prompt, "prompt");
    if (prompt === undefined) throw new Error("prompt is required");

    const model = optionalString(input.model, "model");
    const reasoningEffort = optionalString(input.reasoningEffort, "reasoningEffort");

    // The job id stays the caller's handle; the session id never leaves here.
    const record = this.store.create({
      sessionId: previous.sessionId,
      tier: previous.tier,
      workspace: previous.workspace,
      prompt,
    });

    void this.execute(record, { kind: "resume", id: previous.sessionId }, prompt, {
      model,
      reasoningEffort,
    });

    return {
      jobId: record.jobId,
      sessionId: previous.sessionId,
      status: record.status,
      tier: previous.tier,
      workspace: previous.workspace,
    };
  }

  /** Stop a running job. */
  cancel(jobId: unknown): { jobId: string; status: string } {
    const id = optionalString(jobId, "jobId");
    if (id === undefined) throw new Error("jobId is required");
    const record = this.store.require(id);

    const pid = this.running.get(record.jobId);
    if (pid !== undefined) {
      killTree(pid);
      this.running.delete(record.jobId);
    }
    if (record.status === "running") {
      this.store.append(record, { type: "cancelled", text: "cancelled by the caller" });
      this.store.finish(record, {
        status: "cancelled",
        error: "cancelled by the caller",
      });
    }
    return { jobId: record.jobId, status: record.status };
  }

  /** Block until the job finishes or `seconds` elapse. */
  async waitFor(jobId: string, seconds: number): Promise<JobRecord> {
    const bounded = Math.max(0, Math.min(seconds, MAX_WAIT_SECONDS));
    const deadline = Date.now() + bounded * 1000;
    let record = this.store.require(jobId);
    while (record.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      record = this.store.require(jobId);
    }
    return record;
  }

  private async execute(
    record: JobRecord,
    session: SessionSpec,
    prompt: string,
    options: {
      model?: string | undefined;
      reasoningEffort?: string | undefined;
      maxOutputTokens?: number | undefined;
    },
  ): Promise<void> {
    const settings = writeSettingsFile(record.tier);
    try {
      const argv = buildQoderArgv({
        tier: record.tier,
        settingsPath: settings.path,
        session,
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.reasoningEffort !== undefined
          ? { reasoningEffort: options.reasoningEffort }
          : {}),
        ...(options.maxOutputTokens !== undefined
          ? { maxOutputTokens: options.maxOutputTokens }
          : {}),
      });

      const parser = new StreamParser({
        onEvent: (event) => this.store.append(record, event),
      });

      this.store.append(record, { type: "started", text: `tier=${record.tier}` });

      const result = await runQoder({
        argv,
        cwd: record.workspace,
        env: sanitizeEnv().env,
        stdin: prompt,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        onSpawn: (pid) => {
          this.running.set(record.jobId, pid);
          this.store.update(record, { pid });
        },
        onStdoutLine: (line) => parser.push(line),
      });

      this.running.delete(record.jobId);
      const summary = parser.snapshot;

      // A session id coming back different from the one we minted would mean
      // resume targets the wrong conversation; treat it as a failure rather
      // than storing a handle we do not trust.
      if (summary.sessionId !== undefined && summary.sessionId !== record.sessionId) {
        this.store.finish(record, {
          status: "failed",
          error:
            `the run reported session ${summary.sessionId} but ${record.sessionId} was requested`,
          exitCode: result.exitCode,
        });
        return;
      }

      if (!parser.sawResult) {
        // Exit 0 with no result event is not success: the stream may have been
        // interrupted, and reporting an empty answer would hide that.
        this.store.finish(record, {
          status: result.timedOut ? "failed" : "failed",
          error: describeMissingResult({
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            stderrTail: result.stderrTail,
          }),
          exitCode: result.exitCode,
        });
        return;
      }

      const completed = summary.isError !== true && (result.exitCode === 0 || result.exitCode === null);
      this.store.finish(record, {
        status: completed ? "completed" : "failed",
        ...(summary.resultText !== undefined ? { result: summary.resultText } : {}),
        ...(summary.resultTruncated !== undefined
          ? { resultTruncated: summary.resultTruncated }
          : {}),
        permissionDenials: summary.permissionDenials,
        ...(completed
          ? {}
          : {
              error: `the run reported an error (exit ${String(result.exitCode)})`,
            }),
        exitCode: result.exitCode,
      });
    } catch (error) {
      this.running.delete(record.jobId);
      this.store.finish(record, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      settings.dispose();
    }
  }
}
