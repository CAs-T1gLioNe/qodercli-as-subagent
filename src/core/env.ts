/**
 * The environment handed to the `qoderclicn` child.
 *
 * Built from an **allowlist**, not a denylist. A denylist loses: the variables
 * that matter here are not a fixed set — `GIT_CONFIG_COUNT` plus
 * `GIT_CONFIG_KEY_*`, `BASH_ENV`, `NODE_REPL_EXTERNAL_MODULE`, `PERL5OPT`,
 * `KUBECONFIG`, proxy variables and every `CLAUDE_CODE_*` switch are all
 * capable of redirecting behaviour, and new ones appear with each release.
 *
 * Two things this cannot do, both worth knowing:
 *
 *  - It cannot stop the CLI from merging a project's `.qoder/settings.json`
 *    `env` block into the child's environment. That merge happens inside the
 *    CLI, after we have already spawned it. Excluding the project settings
 *    source is what prevents it, and that is `--setting-sources`'s job.
 *    (The mechanism was measured on Claude Code, which shares the flag and the
 *    settings `env` concept; the Qoder self-check verifies it here.)
 *  - It cannot un-inherit a switch the CLI reads only from the launch
 *    environment. Stripping those is the whole point of the allowlist: a
 *    variable we do not pass is a variable that cannot disarm anything.
 */

/**
 * Variables a child needs to run at all. Deliberately small: nothing here
 * selects credentials, endpoints, proxies, or interpreters.
 */
const ALLOWED_EXACT: ReadonlySet<string> = new Set([
  // Process resolution and basic OS identity.
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "windir",
  "COMSPEC",
  "ComSpec",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  // Temp space. The CLI writes scratch files; it needs somewhere to put them.
  "TEMP",
  "TMP",
  "TMPDIR",
  // Home. Credentials and config are read from here by the CLI itself.
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  // Locale and terminal, so output encoding matches expectations.
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "SHELL",
  "USER",
  "USERNAME",
  "LOGNAME",
]);

/**
 * Pass-through is opt-in and explicit. An operator who needs a gateway or a
 * corporate proxy names the variable; nothing is inherited by default.
 *
 *   QODER_AS_SUBAGENT_PASSTHROUGH=HTTPS_PROXY,NO_PROXY
 */
function passthroughNames(env: NodeJS.ProcessEnv): string[] {
  const raw = env["QODER_AS_SUBAGENT_PASSTHROUGH"];
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

/**
 * Whether to pass an API key through.
 *
 * Off by default, and deliberately so: a subscription login lives on disk in
 * `~/.qoder-cn`, while an inherited credential silently switches the billing
 * instead. Anyone who genuinely wants API-key auth has to say so.
 */
function useApiKey(env: NodeJS.ProcessEnv): boolean {
  return env["QODER_AS_SUBAGENT_USE_API_KEY"] === "1";
}

export interface SanitizedEnv {
  readonly env: NodeJS.ProcessEnv;
  /** Names dropped, for the startup summary. Never values. */
  readonly dropped: string[];
  /** Names passed through because the operator asked for them. */
  readonly passedThrough: string[];
}

export function sanitizeEnv(source: NodeJS.ProcessEnv = process.env): SanitizedEnv {
  const env: NodeJS.ProcessEnv = {};
  const dropped: string[] = [];
  const passedThrough: string[] = [];
  const explicit = new Set(passthroughNames(source));
  const allowKey = useApiKey(source);

  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;

    if (ALLOWED_EXACT.has(name)) {
      env[name] = value;
      continue;
    }
    if (name === "ANTHROPIC_API_KEY" && allowKey) {
      env[name] = value;
      passedThrough.push(name);
      continue;
    }
    if (explicit.has(name)) {
      env[name] = value;
      passedThrough.push(name);
      continue;
    }
    dropped.push(name);
  }

  // Windows tooling misbehaves when these are absent from a child process.
  if (process.platform === "win32") {
    env["SystemRoot"] ??= source["SystemRoot"] ?? "C:\\Windows";
    env["windir"] ??= env["SystemRoot"];
    env["COMSPEC"] ??= source["COMSPEC"] ?? "C:\\Windows\\System32\\cmd.exe";
  }

  return { env, dropped, passedThrough };
}

/**
 * Names only — never values. Dropped variable names can include a credential's
 * *name*, which is harmless; its value never reaches a log.
 */
export function summaryOf(result: SanitizedEnv): {
  kept: number;
  droppedCount: number;
  passedThrough: string[];
} {
  const kept = Object.keys(result.env).length;
  return {
    kept,
    droppedCount: result.dropped.length,
    passedThrough: [...result.passedThrough].sort(),
  };
}
