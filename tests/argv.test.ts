import { describe, expect, it } from "vitest";

import {
  buildQoderArgv,
  ISOLATION_FLAG_PREFIXES,
  type ArgvInput,
} from "../src/core/argv.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

function input(overrides: Partial<ArgvInput> = {}): ArgvInput {
  return {
    tier: "consult",
    settingsPath: "C:/tmp/settings.json",
    session: { kind: "new", id: SESSION_ID },
    ...overrides,
  };
}

function valueOf(argv: readonly string[], flag: string): string {
  const prefix = `${flag}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  if (hit === undefined) throw new Error(`flag ${flag} not present`);
  return hit.slice(prefix.length);
}

describe("buildQoderArgv", () => {
  it("carries the full isolation stack on a first turn", () => {
    const argv = buildQoderArgv(input());
    for (const prefix of ISOLATION_FLAG_PREFIXES) {
      expect(argv.some((a) => a === prefix || a.startsWith(prefix))).toBe(true);
    }
  });

  it("carries the full isolation stack on a resumed turn too", () => {
    // --resume restores none of these. If the resume path ever builds its own
    // argv, this is the test that catches it.
    const argv = buildQoderArgv(input({ session: { kind: "resume", id: SESSION_ID } }));
    for (const prefix of ISOLATION_FLAG_PREFIXES) {
      expect(argv.some((a) => a === prefix || a.startsWith(prefix))).toBe(true);
    }
  });

  it("differs between create and resume ONLY in the session flag", () => {
    const create = buildQoderArgv(input({ session: { kind: "new", id: SESSION_ID } }));
    const resume = buildQoderArgv(input({ session: { kind: "resume", id: SESSION_ID } }));

    const withoutSession = (argv: readonly string[]): string[] =>
      argv.filter((a) => !a.startsWith("--session-id=") && !a.startsWith("--resume="));

    expect(withoutSession(resume)).toEqual(withoutSession(create));
    expect(resume).toHaveLength(create.length);
  });

  // ---------------------------------------------------------------------
  // The Qoder-specific half: flags Claude Code has and Qoder does not must
  // never appear. Sending an unknown option to a commander-based CLI is an
  // error at best and a silent no-op at worst, and each of these was carrying
  // real isolation or a real ceiling on the other CLI.
  // ---------------------------------------------------------------------
  it("never sends flags this CLI does not have", () => {
    const argv = buildQoderArgv(input({ tier: "execute" }));
    const joined = argv.join(" ");

    // Verified absent from `qoderclicn --help` on 1.1.64.
    for (const absent of [
      "--safe-mode", // no equivalent: AGENTS.md/skills/plugins/hooks still load
      "--disable-slash-commands",
      "--restricted",
      "--max-turns", // no turn ceiling exists
      "--max-budget-usd", // no spend ceiling exists
      "--verbose", // stream-json needs no companion flag here
      "--include-partial-messages",
      "--effort=", // Qoder spells it --reasoning-effort
      "--disallowedTools", // and this one --disallowed-tools
      "--allowedTools",
    ]) {
      expect(joined).not.toContain(absent);
    }
  });

  it("uses Qoder's spelling for reasoning effort", () => {
    const argv = buildQoderArgv(input({ reasoningEffort: "high" }));
    expect(valueOf(argv, "--reasoning-effort")).toBe("high");
  });

  it("keeps the variadic flag last", () => {
    const argv = buildQoderArgv(input());
    const at = argv.indexOf("--disallowed-tools");
    expect(at).toBeGreaterThan(-1);

    for (const tail of argv.slice(at + 1)) {
      expect(tail.startsWith("-")).toBe(false);
      if (process.platform !== "win32") expect(tail).toMatch(/^[A-Za-z][A-Za-z0-9_*:-]*$/);
    }
  });

  it("binds every single-value flag with '=' rather than a separate argument", () => {
    const argv = buildQoderArgv(
      input({
        session: { kind: "resume", id: SESSION_ID },
        model: "auto",
        reasoningEffort: "high",
        maxOutputTokens: 4096,
      }),
    );
    const at = argv.indexOf("--disallowed-tools");

    for (let i = 0; i < at; i += 1) {
      const token = argv[i]!;
      if (!token.startsWith("--")) continue;
      if (token.includes("=")) continue;
      const next = argv[i + 1];
      expect(next, `bare flag ${token} must be followed by another flag`).toBeDefined();
      expect(next!.startsWith("--")).toBe(true);
    }
  });

  it("refuses a session id that is not a v4 UUID", () => {
    expect(() =>
      buildQoderArgv(input({ session: { kind: "resume", id: "../../etc/passwd" } })),
    ).toThrow(/v4 UUID/);
    expect(() =>
      buildQoderArgv(
        input({ session: { kind: "resume", id: "C:/Users/x/.qoder/session.jsonl" } }),
      ),
    ).toThrow(/v4 UUID/);
  });

  it("applies the tier's tool set and Qoder's snake_case permission modes", () => {
    const consult = buildQoderArgv(input({ tier: "consult" }));
    const execute = buildQoderArgv(input({ tier: "execute" }));

    expect(valueOf(consult, "--tools").split(",")).toEqual(["Read", "Grep", "Glob"]);
    expect(valueOf(execute, "--tools").split(",")).toContain("Write");

    // consult stays fail-closed; execute uses the classifier-backed mode,
    // because "accept_edits" auto-approves the Edit/Write *tools* only and
    // blocks shell commands outright — measured, and it made the tier useless
    // for anything that has to run a build or a test.
    expect(valueOf(consult, "--permission-mode")).toBe("dont_ask");
    expect(valueOf(execute, "--permission-mode")).toBe("auto");

    // snake_case is sent because it is the documented spelling. camelCase is an
    // accepted alias, so this is a convention check rather than a correctness
    // one — measured on 1.1.64, `acceptEdits` and `dontAsk` both work.
    expect(consult.join(" ")).not.toContain("dontAsk");
    expect(execute.join(" ")).not.toContain("acceptEdits");
  });

  it("always excludes project and local settings, with no way to turn it off", () => {
    for (const tier of ["consult", "execute"] as const) {
      for (const session of [
        { kind: "new", id: SESSION_ID },
        { kind: "resume", id: SESSION_ID },
      ] as const) {
        expect(valueOf(buildQoderArgv(input({ tier, session })), "--setting-sources")).toBe(
          "user",
        );
      }
    }
  });

  it("denies MCP tools, which --tools does not govern", () => {
    expect(buildQoderArgv(input())).toContain("mcp__*");
  });

  it("denies the tools that matter specifically on this CLI", () => {
    const argv = buildQoderArgv(input({ tier: "execute" }));
    // Each of these exists on Qoder and has no Claude Code counterpart.
    for (const tool of [
      "EnterWorktree", // can move the working directory
      "ExitWorktree",
      "CronCreate", // schedules work that outlives the job
      "ScheduleWakeup",
      "CreateGoal", // autonomous goal loop, with no turn ceiling to stop it
      "Agent", // subagent recursion
      "Workflow",
      "ImageGen",
      "VideoGen",
    ]) {
      expect(argv).toContain(tool);
    }
  });

  it("keeps the prompt off the command line", () => {
    const argv = buildQoderArgv(input());
    expect(argv[0]).toBe("-p");
  });
});
