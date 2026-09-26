import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { StreamParser, describeMissingResult, type ParsedEvent } from "../src/core/stream.js";

const here = dirname(fileURLToPath(import.meta.url));

/** A real capture from a tool-using `qoderclicn` turn, not a hand-written mock. */
function realStream(): string[] {
  return readFileSync(join(here, "fixtures", "stream-json-tool-turn.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

function parse(lines: readonly string[]): { parser: StreamParser; events: ParsedEvent[] } {
  const events: ParsedEvent[] = [];
  const parser = new StreamParser({ onEvent: (e) => events.push(e) });
  for (const line of lines) parser.push(line);
  return { parser, events };
}

describe("StreamParser", () => {
  it("extracts the outcome from a real stream", () => {
    const { parser } = parse(realStream());
    const summary = parser.snapshot;

    expect(parser.sawResult).toBe(true);
    expect(summary.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(summary.isError).toBe(false);
    expect(summary.toolCount).toBe(3);
    expect(summary.resultText).toBe("ACK");
  });

  it("does not surface tool results into the event stream", () => {
    // The capture read a file carrying a distinctive payload, and the model's
    // answer is a short acknowledgment — so the payload turning up anywhere in
    // the surfaced events means tool output leaked. Letting it reach the caller
    // is the main injection amplifier: workspace content would enter the
    // subagent's context and then the caller's.
    const { events } = parse(realStream());
    const surfaced = events.map((e) => e.text ?? "").join("\n");

    // Guard the guard: if the fixture ever stops containing the payload, this
    // test would pass while proving nothing.
    const raw = realStream().join("\n");
    expect(raw).toContain("CONFIDENTIAL-PAYLOAD-8f3a2b");

    expect(surfaced).not.toContain("CONFIDENTIAL-PAYLOAD-8f3a2b");
    // The tool result event is still reported, just without its payload.
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
    expect(events.find((e) => e.type === "tool_result")?.text).toBeUndefined();
  });

  it("reports the tools the session actually got", () => {
    // The cheapest way to notice a --tools restriction silently stopped
    // applying is to read it back off the init event.
    const { events } = parse(realStream());
    const init = events.find((e) => e.type === "init");
    expect(init?.text).toContain("Read");
    expect(init?.text).toContain("tools=");
  });

  it("surfaces hook activity rather than dropping it", () => {
    // This capture contains system/hook_started and system/hook_response —
    // events Claude Code does not emit in this shape. They matter here because
    // Qoder has no --safe-mode equivalent, so a workspace's hooks are not
    // excluded and an operator should be able to see one fire.
    const { events } = parse(realStream());
    expect(events.some((e) => e.type === "hook_started")).toBe(true);
    expect(events.some((e) => e.type === "hook_response")).toBe(true);
  });

  it("ignores unknown event types instead of failing", () => {
    const { parser, events } = parse([
      JSON.stringify({ type: "some_future_event", payload: { anything: true } }),
      JSON.stringify({ type: "", weird: 1 }),
    ]);
    expect(parser.sawResult).toBe(false);
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("other:some_future_event");
  });

  it("ignores a system subtype it does not know", () => {
    // artifacts_update appears on Qoder and carries nothing this layer needs.
    const { parser, events } = parse([
      JSON.stringify({ type: "system", subtype: "artifacts_update", artifacts: [] }),
    ]);
    expect(parser.sawResult).toBe(false);
    expect(events).toHaveLength(0);
  });

  it("ignores lines that are not JSON, or not objects", () => {
    const { parser } = parse([
      "Warning: something happened",
      "{ this is not json",
      "[1,2,3]",
      '"a string"',
      "null",
      "",
    ]);
    expect(parser.sawResult).toBe(false);
    expect(parser.snapshot.permissionDenials).toEqual([]);
  });

  it("normalises permission denials from either shape", () => {
    const { parser } = parse([
      JSON.stringify({
        type: "result",
        is_error: false,
        session_id: "s",
        permission_denials: [
          "Bash(rm -rf /)",
          { tool_name: "Write", message: "denied by policy" },
          { command: "git push" },
          { unrecognised: true },
          42,
        ],
      }),
    ]);
    expect(parser.snapshot.permissionDenials).toEqual([
      "Bash(rm -rf /)",
      "Write",
      "git push",
    ]);
  });

  it("bounds a single denial entry", () => {
    const { parser } = parse([
      JSON.stringify({
        type: "result",
        session_id: "s",
        permission_denials: [{ tool_name: "T".repeat(5000) }],
      }),
    ]);
    expect(parser.snapshot.permissionDenials[0]!.length).toBeLessThanOrEqual(201);
  });

  it("truncates an oversized final answer", () => {
    const { parser } = parse([
      JSON.stringify({ type: "result", session_id: "s", result: "x".repeat(400 * 1024) }),
    ]);
    expect(parser.snapshot.resultTruncated).toBe(true);
    expect(parser.snapshot.resultText!.length).toBeLessThan(400 * 1024);
  });

  it("tolerates a torn final line", () => {
    const lines = realStream();
    const torn = [...lines.slice(0, -1), '{"type":"assistant","message":{"cont'];
    const { parser } = parse(torn);
    expect(parser.sawResult).toBe(false); // the torn line was the result
  });
});

describe("describeMissingResult", () => {
  it("distinguishes a timeout from a clean exit with no result", () => {
    expect(
      describeMissingResult({ exitCode: null, timedOut: true, stderrTail: "" }),
    ).toMatch(/time limit/);

    const plain = describeMissingResult({ exitCode: 0, timedOut: false, stderrTail: "" });
    // Exit 0 with no result event must not read as success.
    expect(plain).toMatch(/no result event/);
    expect(plain).toContain("exit 0");
  });

  it("carries the tail of stderr into the message", () => {
    const described = describeMissingResult({
      exitCode: 1,
      timedOut: false,
      stderrTail: "line one\nAPI Error: 500",
    });
    expect(described).toContain("API Error: 500");
  });
});
