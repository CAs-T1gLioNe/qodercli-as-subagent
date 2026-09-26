# qoder-as-subagent

An MCP server that exposes the local **Qoder CN CLI** (`qoderclicn`) as a
subagent, for Codex to delegate review and implementation work to.

Built by copying [`cc-as-subagent`](https://github.com/CAs-T1gLioNe/cc-as-subagent) and adapting it — the
two CLIs share most of their command surface, so the architecture carried over.
**What did not carry over is isolation, and this server is weaker than the
Claude Code one. Read the next two sections before using it.**

> ## Read this first
>
> **This server is a hole in your caller's policy, by construction.** Codex's
> sandbox and approval settings do not govern MCP servers, and they do not
> govern anything an MCP server goes on to spawn.
>
> **This CLI is missing three of the controls the other one has.** Compared with
> [`cc-as-subagent`](https://github.com/CAs-T1gLioNe/cc-as-subagent):
>
> | | Claude Code | Qoder CN |
> |---|---|---|
> | settings isolation (`--setting-sources=user`) | ✓ measured working | ✓ present, **unverified here** |
> | MCP exclusion (`--strict-mcp-config`) | ✓ | ✓ |
> | tool restriction (`--tools` / `--disallowed-tools`) | ✓ | ✓ |
> | drop `AGENTS.md` / skills / plugins / hooks (`--safe-mode`) | ✓ | **✗ no equivalent** |
> | turn ceiling (`--max-turns`) | ✓ | **✗ does not exist** |
> | spend ceiling (`--max-budget-usd`) | ✓ | **✗ does not exist** |
>
> So: **a workspace's `AGENTS.md`, skills, plugins and hooks load**, and **a run
> has no built-in ceiling on turns or cost**. The server's timeout is the only
> bound. See [SECURITY.md](SECURITY.md).
>
> **There is no OS-level sandbox underneath this on Windows.**
>
> **Set `default_tools_approval_mode = "prompt"` in your Codex config** (see
> [examples/codex-config.toml](examples/codex-config.toml)). It is the only
> human checkpoint on this path, and it is off by default.

## What it does

Submits a task to `qoderclicn` in a workspace and returns a job handle
immediately. The run continues in the background; you poll for the result.
Submitting never blocks, because a real review takes minutes and Codex's default
tool timeout is 60 seconds.

Two permission tiers, chosen by the server — the caller names a tier, never a
CLI flag:

| Tier | Tools | Permission mode | Can |
|---|---|---|---|
| `consult` | `Read`, `Grep`, `Glob` | `dont_ask` | read and search; nothing that needs approval |
| `execute` | `+ Edit`, `Write`, `Bash` | `accept_edits` | edit files in the workspace, plus a small set of filesystem commands |

`execute` is narrower than it sounds. With nobody to answer a prompt, anything
that would ask is denied — so `npm test`, `git commit` and `cargo build` all
fail. Only file edits and `mkdir`/`touch`/`mv`/`cp`/`sed` inside the workspace
proceed without asking.

## Requirements

- Node 18+ (developed on 24)
- **Qoder CN CLI installed and signed in.** Verified against `qoderclicn` 1.1.64.
  Resolution order is `QODER_BIN` → `PATH` → `~/.qoder-cn/bin/qoderclicn/`.
  The install path matters: `qodercn` on `PATH` is the **IDE's** launcher
  (`qoder-cn.exe`, which answers `--diff` and `--install-extension`), not this
  program, and resolving by name alone would run the wrong thing.

## Install

```bash
npm install
npm run build
node scripts/selfcheck.mjs   # checks the assumptions against your CLI
npm run probe                # optional: MCP handshake smoke test
```

## Configure Codex

Add the server to `~/.codex/config.toml` — a working example is in
[examples/codex-config.toml](examples/codex-config.toml).

```toml
[mcp_servers.qoder-as-subagent]
command = "node"
args = ["<abs path>/qoder-as-subagent/dist/index.js"]
default_tools_approval_mode = "prompt"

[mcp_servers.qoder-as-subagent.env]
QODER_AS_SUBAGENT_WORKSPACE_ROOTS = "C:\\code\\project-a;C:\\code\\project-b"
```

## Tools

| Tool | Arguments | Returns |
|---|---|---|
| `qoder_run` | `tier`, `prompt`, `workspace`, `model?`, `reasoningEffort?`, `maxOutputTokens?`, `waitSeconds?` | `jobId`, `sessionId`, `status` |
| `qoder_status` | `jobId`, `cursor?`, `waitSeconds?` | `status`, `events`, `result`, `permissionDenials`, `cursor` |
| `qoder_reply` | `jobId`, `prompt`, `model?`, `reasoningEffort?`, `waitSeconds?` | a new `jobId` on the same session |
| `qoder_cancel` | `jobId` | `status` |

`qoder_reply` takes a **job id, never a session id**. The session id stays
server-side, so a caller cannot aim `--resume` at an arbitrary transcript.

Poll with the `cursor` from the previous response to get only new events.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `QODER_AS_SUBAGENT_WORKSPACE_ROOTS` | the server's own cwd | Path-delimiter-separated allowlist. A workspace outside every root is refused. |
| `QODER_AS_SUBAGENT_STATE_DIR` | `%LOCALAPPDATA%\qoder-as-subagent` | Where job state lives. Deliberately outside any workspace, and separate from `cc-as-subagent`'s. |
| `QODER_AS_SUBAGENT_PASSTHROUGH` | *(none)* | Comma-separated variable names to pass through. Everything else is dropped. |
| `QODER_BIN` | resolved as above | Pin an exact CLI build. |

## Verified behaviour

`npm test` — 56 unit tests. `node scripts/e2e.mjs` — 13 checks against the real
CLI: `consult` reads a workspace while being granted no write tool, `execute`
writes, a resumed turn still carries the isolation stack, and the granted tool
list is **exactly** the tier's six.

`node scripts/selfcheck.mjs` re-runs the security assumptions and writes a
verdict to the state directory. Re-run it after a CLI upgrade.

**One check reports `skipped`, and that is the honest result**: I could not make
the settings-injection probe fire on this CLI, so whether `--setting-sources`
actually excludes a workspace's settings is unverified here. The flag is kept
because it is the same flag with the same vocabulary as the CLI where the
mechanism was measured, and it costs nothing — but it is defence, not a verified
fix. Details in [SECURITY.md](SECURITY.md).

## Known limitations

See [SECURITY.md](SECURITY.md) for the reasoning.

- **No `--safe-mode` equivalent.** A workspace's `AGENTS.md`, skills, plugins
  and hooks load. Hook activity is visible in a job's event stream.
- **No turn limit and no spend cap.** A runaway run is bounded only by the
  server's 30-minute timeout.
- **`--setting-sources` is unverified on this CLI.**
- **No OS sandbox on Windows.**
- **Command deny rules are not a security boundary** — they blunt a confused
  model, not a hostile one.
- **Reads inside the workspace are unrestricted.**

## License

MIT — see [LICENSE](LICENSE).
