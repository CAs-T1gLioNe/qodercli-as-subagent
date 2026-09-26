/**
 * Parser for `--output-format stream-json`.
 *
 * Shaped against a captured stream rather than the docs. A tool-using turn on
 * `qoderclicn` 1.1.64 produced seven shapes: `system/init`, `system/artifacts_update`,
 * `system/hook_started`, `system/hook_response`, `assistant`, `user` (carrying
 * tool results) and `result`. The first four and the last match Claude Code's
 * shape; the three `system/*` extras are Qoder's own.
 *
 * Rules this parser follows deliberately:
 *
 *  - **Unknown event types are ignored, never fatal.** The event schema is
 *    internal to the CLI and changes between releases; a parser that throws on
 *    an unfamiliar `type` would break on a routine upgrade.
 *  - **Tool results are not surfaced.** Repository content flows into the
 *    subagent's context and would flow straight back out into the caller's
 *    context, which is the largest injection amplifier in the whole chain.
 *    Only the final answer crosses back by default.
 *  - **Everything kept is bounded.** One `tool_result` can be megabytes.
 */

/** Per-event text kept for the progress log. */
const MAX_EVENT_TEXT = 500;
/** Cap on the final answer handed back to the caller. */
export const MAX_RESULT_TEXT = 256 * 1024;

export interface ParsedEvent {
  readonly type: string;
  readonly text?: string;
}

export interface StreamSummary {
  sessionId?: string;
  model?: string;
  toolCount?: number;
  resultText?: string;
  resultTruncated?: boolean;
  isError?: boolean;
  numTurns?: number;
  costUsd?: number;
  permissionDenials: string[];
}

function clip(value: string, limit = MAX_EVENT_TEXT): string {
  return value.length > limit ? value.slice(0, limit) + "…" : value;
}

/** Content-block text, ignoring block types we do not surface. */
function textFromBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record["type"] === "text" && typeof record["text"] === "string") {
      out.push(record["text"]);
    }
  }
  return out;
}

/** Tool names used in an assistant turn, for progress reporting only. */
function toolNamesFromBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record["type"] === "tool_use" && typeof record["name"] === "string") {
      out.push(record["name"]);
    }
  }
  return out;
}

/**
 * Denial entries vary by CLI version — strings in some builds, objects with a
 * tool or command field in others. Normalise without assuming a shape, and
 * remember the text is model-authored, so it is data about the run and not
 * something to be replayed into a caller as an instruction.
 */
function normaliseDenials(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      out.push(clip(entry, 200));
      continue;
    }
    if (entry !== null && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      const label =
        (typeof record["tool_name"] === "string" && record["tool_name"]) ||
        (typeof record["tool"] === "string" && record["tool"]) ||
        (typeof record["command"] === "string" && record["command"]) ||
        (typeof record["message"] === "string" && record["message"]);
      if (typeof label === "string" && label !== "") out.push(clip(label, 200));
    }
  }
  return out;
}

export class StreamParser {
  private readonly summary: StreamSummary = { permissionDenials: [] };
  private sawResultEvent = false;
  private readonly onEvent: ((event: ParsedEvent) => void) | undefined;

  constructor(options: { onEvent?: (event: ParsedEvent) => void } = {}) {
    this.onEvent = options.onEvent;
  }

  /** Feed one line of NDJSON. Never throws. */
  push(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") return;

    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
      event = parsed as Record<string, unknown>;
    } catch {
      // A non-JSON line is possible (a stray warning); ignore rather than fail
      // the whole run over it.
      return;
    }

    const type = typeof event["type"] === "string" ? event["type"] : "";
    switch (type) {
      case "system":
        this.handleSystem(event);
        return;
      case "assistant":
        this.handleAssistant(event);
        return;
      case "user":
        // Tool results. Deliberately not surfaced — see the file header.
        this.emit({ type: "tool_result" });
        return;
      case "result":
        this.handleResult(event);
        return;
      default:
        // Unknown and future event types: count them, do not choke.
        this.emit({ type: `other:${type || "unknown"}` });
        return;
    }
  }

  private emit(event: ParsedEvent): void {
    this.onEvent?.(event);
  }

  private handleSystem(event: Record<string, unknown>): void {
    const subtype = event["subtype"];

    // Hooks running is worth surfacing rather than dropping: this CLI has no
    // `--safe-mode` equivalent, so a workspace's hooks are not excluded and an
    // operator watching a job should be able to see that one fired.
    if (subtype === "hook_started" || subtype === "hook_response") {
      const name = typeof event["hook_name"] === "string" ? event["hook_name"] : "?";
      const hookEvent =
        typeof event["hook_event"] === "string" ? event["hook_event"] : undefined;
      const outcome = typeof event["outcome"] === "string" ? event["outcome"] : undefined;
      this.emit({
        type: subtype,
        text: clip(
          [name, hookEvent, outcome].filter((v) => v !== undefined).join(" · "),
          200,
        ),
      });
      return;
    }

    if (subtype !== "init") return;
    if (typeof event["session_id"] === "string") {
      this.summary.sessionId = event["session_id"];
    }
    if (typeof event["model"] === "string") this.summary.model = event["model"];
    if (Array.isArray(event["tools"])) this.summary.toolCount = event["tools"].length;

    // The init event states which tools the session actually got, which is the
    // cheapest way to notice that a --tools restriction silently stopped
    // applying.
    const tools = Array.isArray(event["tools"]) ? event["tools"].join(",") : "?";
    this.emit({
      type: "init",
      text: clip(`session ${String(event["session_id"] ?? "?")} · tools=[${tools}]`),
    });
  }

  private handleAssistant(event: Record<string, unknown>): void {
    const message = event["message"];
    if (message === null || typeof message !== "object") return;
    const record = message as Record<string, unknown>;

    for (const text of textFromBlocks(record["content"])) {
      if (text.trim() === "") continue;
      this.emit({ type: "assistant", text: clip(text) });
    }
    for (const name of toolNamesFromBlocks(record["content"])) {
      this.emit({ type: "tool_use", text: clip(name, 100) });
    }
  }

  private handleResult(event: Record<string, unknown>): void {
    this.sawResultEvent = true;

    if (typeof event["session_id"] === "string") {
      this.summary.sessionId = event["session_id"];
    }
    if (typeof event["is_error"] === "boolean") this.summary.isError = event["is_error"];
    if (typeof event["num_turns"] === "number") this.summary.numTurns = event["num_turns"];
    if (typeof event["total_cost_usd"] === "number") {
      this.summary.costUsd = event["total_cost_usd"];
    }

    const denials = normaliseDenials(event["permission_denials"]);
    if (denials.length > 0) {
      this.summary.permissionDenials = denials;
      this.emit({
        type: "permission_denied",
        text: clip(`${denials.length} denied: ${denials.slice(0, 3).join("; ")}`),
      });
    }

    if (typeof event["result"] === "string") {
      const text = event["result"];
      this.summary.resultText = clip(text, MAX_RESULT_TEXT);
      this.summary.resultTruncated = text.length > MAX_RESULT_TEXT;
    }
  }

  /** True once a terminal `result` event has been seen. */
  get sawResult(): boolean {
    return this.sawResultEvent;
  }

  /** Snapshot of everything extracted so far. */
  get snapshot(): Readonly<StreamSummary> {
    return this.summary;
  }
}

/**
 * Turn an exit into the reason a run has no answer.
 *
 * A missing `result` event is the interesting case: the CLI can exit zero
 * after an interrupted or truncated stream, and treating that as success would
 * hand the caller an empty answer with no indication anything went wrong.
 */
export function describeMissingResult(input: {
  exitCode: number | null;
  timedOut: boolean;
  stderrTail: string;
}): string {
  if (input.timedOut) return "the run exceeded its time limit and was stopped";
  const tail = input.stderrTail.trim();
  const detail = tail === "" ? "" : `: ${tail.split("\n").slice(-3).join(" | ")}`;
  return (
    `the run produced no result event (exit ${String(input.exitCode)})` + detail
  );
}
