/**
 * The permission policy: what each tier may do, and what is denied outright.
 *
 * Adapted from `cc-as-subagent`. Two things changed for Qoder:
 *
 *  - **Permission mode values are snake_case.** Qoder accepts `default`,
 *    `accept_edits`, `bypass_permissions`, `dont_ask`, `auto`; Claude Code
 *    spells the same modes `acceptEdits`, `dontAsk`. The camelCase spelling is
 *    rejected, so this is a hard difference rather than a cosmetic one.
 *
 *  - **The tool vocabulary is different.** Qoder's `--tools` list is not
 *    Claude Code's, and it includes tools Claude Code has no counterpart for —
 *    `EnterWorktree`/`ExitWorktree` (which can move the working directory),
 *    `Cron*`/`ScheduleWakeup` (scheduling), `Workflow`, and image/video
 *    generators that call external services. The names below were read back
 *    from a live session's own init event rather than from documentation.
 */

export type Tier = "consult" | "execute";

export const TIERS: readonly Tier[] = ["consult", "execute"];

export function isTier(value: unknown): value is Tier {
  return value === "consult" || value === "execute";
}

/**
 * Built-in tools each tier may use.
 *
 * Named explicitly. On Qoder `--tools` also accepts `""` for none and
 * `default` for all — `default` is deliberately never used, since it means
 * "every tool" rather than "the usual set", which is the opposite of what the
 * word suggests.
 */
export const TIER_TOOLS: Record<Tier, readonly string[]> = {
  consult: ["Read", "Grep", "Glob"],
  execute: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
};

/**
 * `dont_ask` denies anything not already allowed, which is the fail-closed mode
 * for read-only work. `accept_edits` additionally auto-approves file edits and
 * a small set of filesystem commands inside the working directory.
 */
export const TIER_PERMISSION_MODE: Record<Tier, string> = {
  consult: "dont_ask",
  execute: "accept_edits",
};

/**
 * Tools denied through `--disallowed-tools`.
 *
 * A tier grants exactly its set, so everything a live session was seen to
 * offer beyond `Read,Grep,Glob,Edit,Write,Bash` is named here. Several matter
 * more on Qoder than their Claude Code counterparts would:
 *
 *  - `EnterWorktree` / `ExitWorktree` can move the working directory out from
 *    under the workspace allowlist.
 *  - `Agent` spawns subagents, which is recursion out of this policy.
 *  - `Cron*` / `ScheduleWakeup` schedule work that outlives the job — and Qoder
 *    has no turn or spend ceiling to stop it.
 *  - `CreateGoal` / `UpdateGoal` drive an autonomous goal loop for the same
 *    reason.
 *  - `ImageGen` / `VideoGen*` / `WebFetch` / `WebSearch` reach external
 *    services from a workspace we do not trust.
 */
export const DENIED_TOOLS: readonly string[] = [
  "mcp__*",
  // Recursion and orchestration.
  "Agent",
  "Workflow",
  "Skill",
  // Workspace escape.
  "EnterWorktree",
  "ExitWorktree",
  // Work that outlives the job.
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "CreateGoal",
  "GetGoal",
  "UpdateGoal",
  // Task-tracking family. Noise for a bounded subagent turn.
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskStop",
  "TaskUpdate",
  // Network egress.
  "WebFetch",
  "WebSearch",
  // External generation services.
  "ImageGen",
  "ImageSearch",
  "VideoGen",
  "VideoGenRetrieve",
  // Interactive and editor surfaces.
  "Monitor",
  "NotebookEdit",
];

/**
 * Command-level deny rules, passed via `--settings`.
 *
 * These are shell-level and therefore identical for both CLIs — the same
 * limitation applies: the rules match the command text the model writes, and
 * the CLI's own documentation says such a rule "isn't a security boundary
 * around the program". They blunt a confused model, not a hostile workspace.
 */
const DENY_COMMANDS: readonly string[] = [
  // Interpreters and runners are arbitrary code execution; denying these
  // matters far more than trying to enumerate destructive binaries.
  "Bash(sh *)", "Bash(bash *)", "Bash(zsh *)", "Bash(dash *)",
  "Bash(env *)", "Bash(eval *)", "Bash(exec *)", "Bash(source *)",
  "Bash(xargs*)", "Bash(nohup *)", "Bash(setsid *)", "Bash(flock *)",
  "Bash(python*)", "Bash(py *)", "Bash(node *)", "Bash(npm *)",
  "Bash(npx *)", "Bash(bun *)", "Bash(deno *)", "Bash(pip *)",
  "Bash(uv *)", "Bash(ruby *)", "Bash(perl *)", "Bash(php *)",
  "Bash(pwsh*)", "Bash(powershell*)", "Bash(cmd*)", "Bash(cscript*)",
  "Bash(wscript*)", "Bash(mshta*)", "Bash(rundll32*)", "Bash(regsvr32*)",
  "Bash(awk *)", "Bash(sed -i*)", "Bash(tee *)", "Bash(find * -exec*)",
  "Bash(find * -delete*)",
  // Container and environment runners are not stripped as wrappers.
  "Bash(docker *)", "Bash(podman *)", "Bash(devbox run*)",
  "Bash(mise exec*)", "Bash(direnv exec*)", "Bash(watch *)",
  // git meta-options execute arbitrary programs.
  "Bash(git -c*)", "Bash(git --exec-path*)",

  // Irreversible damage.
  "Bash(rm -*)", "Bash(rm --*)", "Bash(rmdir *)", "Bash(dd *)",
  "Bash(mkfs*)", "Bash(shred *)", "Bash(truncate *)", "Bash(chmod *)",
  "Bash(chown *)", "Bash(icacls *)", "Bash(attrib *)", "Bash(takeown *)",
  "Bash(reg add*)", "Bash(reg delete*)", "Bash(schtasks *)", "Bash(sc *)",
  "Bash(taskkill *)", "Bash(shutdown *)", "Bash(net *)",

  // Destructive git.
  "Bash(git clean *)", "Bash(git reset --hard*)", "Bash(git checkout -- *)",
  "Bash(git restore *)", "Bash(git push --force*)", "Bash(git push -f*)",
  "Bash(git branch -D*)", "Bash(git update-ref -d*)", "Bash(git reflog delete*)",
  "Bash(git filter-branch*)", "Bash(git worktree remove*)",
  "Bash(git stash drop*)", "Bash(git stash clear*)",

  // Egress. On Windows there is no sandbox to pair this with, so treat it as a
  // speed bump only.
  "Bash(curl *)", "Bash(wget *)", "Bash(nc *)", "Bash(ncat *)",
  "Bash(scp *)", "Bash(rsync *)", "Bash(sftp *)", "Bash(ssh *)",
  "Bash(telnet *)", "Bash(certutil *)", "Bash(bitsadmin *)",
  "Bash(Invoke-WebRequest *)", "Bash(Invoke-RestMethod *)",
];

/**
 * Reads that are denied even inside the working directory.
 *
 * Protected-path handling covers writes only, so unrelated credentials sitting
 * next to the project stay readable unless named here.
 */
const DENY_READS: readonly string[] = [
  "Read(~/.qoder-cn/**)",
  "Read(~/.claude/**)",
  "Read(~/.ssh/**)",
  "Read(~/.aws/**)",
  "Read(~/.azure/**)",
  "Read(~/.kube/**)",
  "Read(~/.config/gcloud/**)",
  "Read(~/.docker/**)",
  "Read(**/.env)",
  "Read(**/.env.*)",
  "Read(**/*.pem)",
  "Read(**/id_rsa*)",
  "Read(**/credentials)",
];

export const DENY_RULES: readonly string[] = [...DENY_COMMANDS, ...DENY_READS];

export interface SettingsFile {
  permissions: { deny: string[] };
}

/**
 * The settings document handed to `--settings`.
 *
 * Deliberately narrow: `--setting-sources=user` already excludes the
 * workspace's own settings, so there is nothing to configure here beyond deny
 * rules.
 */
export function buildSettings(tier: Tier): SettingsFile {
  void tier;
  return { permissions: { deny: [...DENY_RULES] } };
}

/** Cap on how much denial detail is handed back. */
const MAX_DENIALS_REPORTED = 8;
const MAX_DENIAL_CHARS = 120;

/**
 * Condense denials before they go back to the caller.
 *
 * The text of a denial is something the model wrote, influenced by whatever it
 * read in the workspace. Replaying it verbatim would open a channel for
 * workspace content to reach the calling agent as if it were our own output,
 * so only a short, clearly-bounded sample crosses back.
 */
export function summarizeDenials(denials: readonly string[]): {
  count: number;
  sample: string[];
  truncated: boolean;
} {
  const sample = denials
    .slice(0, MAX_DENIALS_REPORTED)
    .map((entry) =>
      entry.length > MAX_DENIAL_CHARS ? entry.slice(0, MAX_DENIAL_CHARS) + "…" : entry,
    );
  return {
    count: denials.length,
    sample,
    truncated: denials.length > MAX_DENIALS_REPORTED,
  };
}
