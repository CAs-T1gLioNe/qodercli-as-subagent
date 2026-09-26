/**
 * The one place a `qoderclicn` command line is built.
 *
 * Adapted from `cc-as-subagent`. The two CLIs share most of their surface —
 * `-p`, `--output-format`, `--setting-sources`, `--settings`, `--tools`,
 * `--strict-mcp-config`, `--session-id`, `--resume` are all the same flag with
 * the same meaning. What differs is listed at each point below, and every
 * difference was read off `qoderclicn --help` or a real run, not from the docs
 * site (whose command name refers to the IDE launcher, not this binary).
 *
 * Two rules carried over unchanged:
 *
 *  1. There is exactly one builder, and both the first turn and every resumed
 *     turn go through it. `--resume` restores none of the isolation flags, so a
 *     resume path that assembled its own argv would silently run unconfined.
 *
 *  2. Every value is bound with `=`. `--resume` in particular takes an optional
 *     value, so a space-separated form lets a value starting with `-` detach
 *     into a separate flag.
 */

import { DENIED_TOOLS, TIER_PERMISSION_MODE, TIER_TOOLS, type Tier } from "./policy.js";

export type SessionSpec =
  | { readonly kind: "new"; readonly id: string }
  | { readonly kind: "resume"; readonly id: string };

export interface ArgvInput {
  readonly tier: Tier;
  /** Path to the temp file holding the deny rules for `--settings`. */
  readonly settingsPath: string;
  readonly session: SessionSpec;
  readonly model?: string;
  /** Qoder spells this `--reasoning-effort`; Claude Code spells it `--effort`. */
  readonly reasoningEffort?: string;
  /**
   * The only spend brake available. Qoder has no `--max-budget-usd`, and no
   * `--max-turns` either, so a run has no built-in ceiling on either turns or
   * cost — this bounds one response, not the whole run.
   */
  readonly maxOutputTokens?: number;
  /**
   * Print mode only. Prevents the transcript reaching disk, which also means
   * the session cannot be resumed afterwards.
   */
  readonly noSessionPersistence?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The setting sources every run loads.
 *
 * Hard-coded rather than configurable, for the same reason as in
 * `cc-as-subagent`: it is the one flag standing between a workspace and the
 * run. A repository's own settings can put anything it likes in its `env`
 * block, and Claude Code was measured passing those values straight into the
 * process. `--setting-sources` exists on Qoder with the same `user, project,
 * local` vocabulary, and the startup self-check verifies it behaves the same
 * way here rather than assuming it.
 */
const SETTING_SOURCES = "user";

/**
 * `--resume` takes an ID, and on Claude Code it also accepts the absolute path
 * to a transcript file — which would make a caller-influenced value an
 * arbitrary-file-read primitive. Qoder's help documents only "Resume a previous
 * session by identifier", but the check is cheap and the failure mode is severe,
 * so IDs minted here are validated at the lowest layer regardless.
 */
function assertSessionId(id: string): void {
  if (!UUID_RE.test(id)) {
    throw new Error(
      `refusing to use a session id that is not a v4 UUID: ${JSON.stringify(id)}`,
    );
  }
}

export function buildQoderArgv(input: ArgvInput): readonly string[] {
  assertSessionId(input.session.id);

  const argv: string[] = ["-p"];

  // ---- isolation stack -------------------------------------------------
  // Keeps workspace-supplied settings files and .mcp.json out of the process.
  // Not a parameter: see SETTING_SOURCES.
  argv.push(`--setting-sources=${SETTING_SOURCES}`);
  // MCP is the one surface `--tools` does not govern, so it is closed twice.
  argv.push("--strict-mcp-config", `--mcp-config={"mcpServers":{}}`);
  //
  // NOT PRESENT HERE, unlike `cc-as-subagent`:
  //   --safe-mode              Qoder has no equivalent. AGENTS.md, skills,
  //                            plugins, hooks and memories still load.
  //   --disable-slash-commands Qoder has no equivalent.
  //   --restricted             Qoder has no equivalent.
  // The first is the significant one: `--setting-sources` excludes a
  // workspace's settings *files*, but the filesystem-discovered inputs above
  // are not settings files, so nothing here stops them. See SECURITY.md.

  // ---- tier policy -----------------------------------------------------
  //
  // `--tools` is documented on Qoder as `<tools...>`, i.e. variadic, where
  // Claude Code takes one comma-joined value. The comma form is sent here and
  // the startup self-check reads the granted tool list back off the session's
  // own init event, so a wrong guess fails loudly instead of silently leaving
  // the session with every tool.
  argv.push(`--tools=${TIER_TOOLS[input.tier].join(",")}`);
  // Values are snake_case on Qoder (`dont_ask`, `accept_edits`); Claude Code
  // uses camelCase. Passing the camelCase spelling fails outright.
  argv.push(`--permission-mode=${TIER_PERMISSION_MODE[input.tier]}`);
  argv.push(`--settings=${input.settingsPath}`);

  // ---- session ---------------------------------------------------------
  argv.push(
    input.session.kind === "new"
      ? `--session-id=${input.session.id}`
      : `--resume=${input.session.id}`,
  );

  // ---- optional knobs --------------------------------------------------
  if (input.model !== undefined) argv.push(`--model=${input.model}`);
  if (input.reasoningEffort !== undefined) {
    argv.push(`--reasoning-effort=${input.reasoningEffort}`);
  }
  if (input.maxOutputTokens !== undefined) {
    argv.push(`--max-output-tokens=${String(input.maxOutputTokens)}`);
  }
  if (input.noSessionPersistence === true) argv.push("--no-session-persistence");

  // ---- output ----------------------------------------------------------
  // Qoder has no `--verbose`; stream-json works on its own. The prompt travels
  // on stdin.
  argv.push("--output-format=stream-json");

  // ---- variadic, therefore last ---------------------------------------
  // `--disallowed-tools` takes multiple values. Anything after it risks being
  // swallowed as another value, so nothing is appended past this point.
  argv.push("--disallowed-tools", ...DENIED_TOOLS);

  return argv;
}

/**
 * The isolation flags that a resumed turn must repeat. Exported so a test can
 * assert that a resume argv still carries every one of them — dropping any
 * single entry means that turn runs with less isolation than the first.
 */
export const ISOLATION_FLAG_PREFIXES: readonly string[] = [
  "--setting-sources=",
  "--strict-mcp-config",
  "--mcp-config=",
  "--tools=",
  "--permission-mode=",
  "--settings=",
];
