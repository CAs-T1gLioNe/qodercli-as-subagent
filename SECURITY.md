# Threat model

## What this server is

A bridge that lets one agent (Codex) drive another (Qoder CN) as a subagent. It
spawns `qoderclicn` with a policy fixed by this server, and relays the result.

Two consequences follow immediately:

1. **The caller's policy does not apply.** Codex's sandbox and permission
   profiles govern commands Codex runs directly. MCP servers "use their own
   controls". Nothing Codex does bounds what this server, or the CLI it spawns,
   may do.
2. **The workspace is input to a process that can act on it.**

## This is weaker than `cc-as-subagent`

It was built by adapting that server, and the two CLIs are close enough in
command surface that the architecture transferred. The isolation did not.

| Control | Claude Code | Qoder CN |
|---|---|---|
| `--setting-sources=user` | present, **measured working** | present, **unverified** |
| `--strict-mcp-config` + empty `--mcp-config` | ✓ | ✓ |
| `--tools` / `--disallowed-tools` | ✓ | ✓ |
| `--safe-mode` (drops `AGENTS.md`, skills, plugins, hooks, memories) | ✓ | **absent** |
| `--max-turns` | ✓ | **absent** |
| `--max-budget-usd` | ✓ | **absent** |
| `--restricted` | 2.1.248+ | **absent** |
| `--disable-slash-commands` | ✓ | **absent** |

Everything in the "absent" rows is a real reduction, not a renaming. A workspace
under review can therefore do three things it could not do against the other
server:

### 1. Its `AGENTS.md`, skills, plugins and hooks still load

`--setting-sources=user` excludes a workspace's settings *files*. It does not
exclude the things the CLI discovers from the filesystem, and Claude Code's
`--safe-mode` was what covered those. Qoder has no equivalent.

This is not theoretical. The tool-using capture kept as a test fixture contains
`system/hook_started` and `system/hook_response` events — **hooks ran during a
run that was supposed to be read-only**. Those events are surfaced in the job's
event stream rather than dropped, so an operator can at least see it happen.

### 2. There is no turn ceiling

Claude Code's `--max-turns` bounds an agentic loop. Nothing equivalent exists
here, so a job that keeps going keeps going.

### 3. There is no spend ceiling

`--max-budget-usd` does not exist. Qoder accounts in credits (`total_credits`
appears in its result event) and offers no flag to cap them. `--max-output-tokens`
is exposed because it is the only brake available, and it bounds one response —
**not** the run.

Together, 2 and 3 mean the server's own 30-minute timeout is the only bound on a
runaway job. That is a wall-clock bound, not a cost bound.

## `--setting-sources=user` is unverified on this CLI

The flag exists on Qoder with the same `user, project, local` vocabulary, and it
is kept because it is the only thing standing between a workspace and the run.

But it is **not verified here**. On Claude Code the mechanism was measured
directly: a project settings `env` block reached the process and changed the
model the session ran on, and `--setting-sources=user` stopped it. Four attempts
to reproduce that on Qoder all failed to produce *any* observable effect:

| Probe | Result |
|---|---|
| `.qoder/settings.json` → `env.QODERCN_MODEL` | model unchanged |
| `.qoder/settings.json` → `model` | model unchanged |
| `.qoder/settings.json` → `outputStyle` | output style unchanged |
| `.qoder/settings.json` → `enabledPlugins` | plugin list unchanged |

None of these could be made to fire even through `--settings`, which is always
loaded — so the probes themselves are the more likely problem, not the guard.
Whether a workspace can reconfigure a run on this CLI is therefore **unknown in
both directions**.

The self-check reports this as `skipped`, not `pass`. A check that says "the bad
thing did not happen" is indistinguishable from a broken probe, and recording it
as a pass would be a false all-clear on the one control that matters most here.

**Concrete next step**: the CLI has a `config` subcommand and a
`~/.qoder-cn/settings.json` whose real schema starts with
`aicodingPluginSettingsMigrationVersion`, `enabledPlugins`, `permissions`
(including `trustDirectories`), and `security`. The project-level equivalent —
its path and which keys it honours — is what a working probe needs.

## What is enforced

Launched through one argv builder, shared by the first turn and every resumed
turn:

| Flag | Effect |
|---|---|
| `--setting-sources=user` | Excludes a workspace's settings files. Unverified — see above. |
| `--strict-mcp-config` + empty `--mcp-config` | MCP servers come from nowhere. |
| `--tools=<tier set>` | Restricts which built-in tools exist at all. |
| `--permission-mode=<dont_ask\|accept_edits>` | The tier's baseline. |
| `--settings=<generated>` | Deny rules, written fresh per run and deleted after. |
| `--disallowed-tools …` | Last, because it is variadic. The only channel a user's own settings cannot re-allow. |

Plus, outside the CLI:

- **The workspace is an allowlist, not an argument.** UNC paths, device paths,
  relative paths and non-existent paths are refused; symlink and junction
  escapes are caught by resolving before comparing.
- **The environment is an allowlist.** Credentials, `GIT_*`, proxies,
  interpreters' injection variables and every `QODERCN_*` switch are dropped.
- **Session ids are minted here and never accepted from the caller**, and
  validated as v4 UUIDs before they can reach a command line.
- **Job ids are capabilities.** Unknown ids are refused, never created on first
  sight. State lives under `%LOCALAPPDATA%\qoder-as-subagent`, separate from the
  other server's directory.
- **Tool results are not relayed.** Only the final answer crosses back.
- **Denial text is summarised**, not passed through.

## What is *not* enforced

- **No OS-level sandbox on native Windows.**
- **No turn ceiling, no spend ceiling** — the largest gap versus the other
  server.
- **`AGENTS.md`, skills, plugins and hooks from the workspace load.**
- **Deny rules are not a boundary.** The rules match the command text the model
  writes, and such a rule "isn't a security boundary around the program":
  `/bin/rm -rf x`, `bash -c 'rm -rf x'`, and a build script that calls `rm` all
  slip past.
- **Reads inside the workspace are unrestricted.**
- **Workspace trust is persistent**, so a directory the user once accepted
  carries its own `permissions.allow` into these runs.

## Verified against the real CLI

`node scripts/selfcheck.mjs`, on `qoderclicn` 1.1.64 / Windows 11:

| Check | Result |
|---|---|
| `--setting-sources=user` is load-bearing | **skipped — probe could not be made to fire** |
| `--tools` restriction is effective | pass — session reports `[Glob, Grep, Read]` |
| `--disallowed-tools` variadic did not swallow later flags | pass |
| `--session-id` round-trip | pass |
| No turn limit or spend cap exists | pass — confirmed for this version |

The last check is deliberately a check and not an assumption: it is a statement
about a *version*, and if a future release adds either flag the self-check fails
so the policy can be tightened.

## Reporting

This is a personal tool, not a published package. If you deploy it somewhere
that matters, re-run the self-check and re-read the limitations above first.
