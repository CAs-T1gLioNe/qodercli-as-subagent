/**
 * Child-process lifecycle for a `qoderclicn` run.
 *
 * Two behaviours here are load-bearing and easy to get wrong:
 *
 *  - **Never stop reading a pipe.** Hitting an output cap must stop
 *    *accumulating*, not stop *reading*. A child blocked writing into a full
 *    pipe never exits, so the job would hang forever instead of failing.
 *
 *  - **Kill the whole tree.** A timeout that only signals the direct child
 *    leaves grandchildren (a dev server, a test runner) holding the workspace.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface SpawnInput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin?: string;
  readonly timeoutMs: number;
  /** Called once per complete stdout line. Must not throw. */
  readonly onStdoutLine?: (line: string) => void;
  /** Called with raw stderr chunks, already capped by the caller. */
  readonly onStderr?: (chunk: string) => void;
  /** Hard cap on a single stdout line before it is truncated and resynced. */
  readonly maxLineBytes?: number;
  /** Called once with the child's pid, so a caller can cancel the run. */
  readonly onSpawn?: (pid: number) => void;
}

export interface SpawnResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly stderrTail: string;
  readonly stdoutTruncated: boolean;
}

const DEFAULT_MAX_LINE_BYTES = 1 << 20; // 1 MiB
const STDERR_TAIL_BYTES = 8 * 1024;
const KILL_GRACE_MS = 5_000;

/** The command name, as the CLI's own help calls it. */
const BIN_NAME = "qoderclicn";

/**
 * Where the installer puts it, relative to the user's home.
 *
 * This step exists because the CLI is **not on PATH** on a normal install —
 * `qodercn` on PATH is the IDE's launcher (`qoder-cn.exe`, which answers
 * `--diff` and `--install-extension`), not this program. Resolving by name
 * alone would silently run the wrong binary, so the known location is checked
 * before falling back.
 */
const INSTALL_SUBPATH = [".qoder-cn", "bin", "qoderclicn"];

/**
 * Resolve the CLI.
 *
 * Order: an explicit override, then PATH, then the install location. The
 * override wins so a caller can pin an exact build.
 */
export function resolveQoderBin(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["QODER_BIN"];
  if (override && override.trim() !== "") return override;

  const isWin = process.platform === "win32";
  const exts = isWin ? (env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";") : [""];

  const findIn = (dir: string): string | undefined => {
    for (const ext of exts) {
      for (const name of [`${BIN_NAME}${ext}`, `${BIN_NAME}${ext.toLowerCase()}`]) {
        const candidate = join(dir, name);
        if (existsSync(candidate)) return candidate;
      }
    }
    return undefined;
  };

  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (dir === "") continue;
    const hit = findIn(dir);
    if (hit !== undefined) return hit;
  }

  const home = env["USERPROFILE"] ?? env["HOME"];
  if (home !== undefined && home.trim() !== "") {
    const installed = findIn(join(home, ...INSTALL_SUBPATH));
    if (installed !== undefined) return installed;
  }

  // Nothing found: return the bare name so the spawn error names the program
  // the operator needs to install.
  return BIN_NAME;
}

/**
 * Kill `pid` and everything it started, escalating if the tree ignores a
 * graceful signal.
 */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    // Windows has no process-group signal; taskkill walks the tree for us.
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

/** Escalation pass, called once the grace period has elapsed. */
function killTreeHard(pid: number): void {
  if (process.platform === "win32") return; // taskkill /F is already hard
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

class LineSplitter {
  private buffer = "";

  constructor(
    private readonly maxBytes: number,
    private readonly onLine: (line: string) => void,
    private readonly onTruncate: () => void,
  ) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) this.onLine(line);
      index = this.buffer.indexOf("\n");
    }
    // A line longer than the cap can never complete; drop it and resync at the
    // next newline rather than growing without bound.
    if (this.buffer.length > this.maxBytes) {
      this.buffer = "";
      this.onTruncate();
    }
  }

  flush(): void {
    if (this.buffer.length > 0) {
      this.onLine(this.buffer);
      this.buffer = "";
    }
  }
}

export function runQoder(input: SpawnInput): Promise<SpawnResult> {
  const bin = resolveQoderBin(input.env);
  const maxLineBytes = input.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;

  return new Promise<SpawnResult>((resolve, reject) => {
    const startedAt = Date.now();
    let child: ChildProcess;

    try {
      child = spawn(bin, [...input.argv], {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        // A new process group is what makes a tree-wide kill possible.
        detached: process.platform !== "win32",
      });
    } catch (error) {
      reject(error);
      return;
    }

    if (child.pid !== undefined) input.onSpawn?.(child.pid);

    let timedOut = false;
    let stdoutTruncated = false;
    let stderrTail = "";

    const splitter = new LineSplitter(
      maxLineBytes,
      (line) => input.onStdoutLine?.(line),
      () => {
        stdoutTruncated = true;
      },
    );

    // Both pipes are read unconditionally for the lifetime of the child. Caps
    // bound what we keep, never whether we read.
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => splitter.push(chunk));

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const next = stderrTail + chunk;
      stderrTail = next.length > STDERR_TAIL_BYTES ? next.slice(-STDERR_TAIL_BYTES) : next;
      input.onStderr?.(chunk);
    });

    // Swallow EPIPE: the child can exit while we are still writing stdin.
    child.stdin?.on("error", () => {});
    if (input.stdin !== undefined) child.stdin?.end(input.stdin);
    else child.stdin?.end();

    const killTimer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
      const hardTimer = setTimeout(() => {
        if (child.pid !== undefined) killTreeHard(child.pid);
      }, KILL_GRACE_MS);
      hardTimer.unref();
    }, input.timeoutMs);
    killTimer.unref();

    const done = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(killTimer);
      splitter.flush();
      resolve({
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stderrTail,
        stdoutTruncated,
      });
    };

    child.on("error", (error) => {
      clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", done);
  });
}
