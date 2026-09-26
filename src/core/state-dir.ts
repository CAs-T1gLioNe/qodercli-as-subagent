/**
 * Where job state lives, and why it lives there.
 *
 * Job records carry prompts (in part), answers and tool output. Keeping them
 * inside the workspace would mean:
 *   - the model's own `rm` / `git clean` can delete the bridge's state,
 *   - `git add .` commits them,
 *   - on a shared checkout, other users read them.
 *
 * `%TEMP%` is also wrong: on Windows it is commonly world-readable, and a
 * directory junction (mklink /J, which needs no elevation) can silently
 * redirect writes anywhere. So the state root is per-user application data,
 * and every write is checked for having landed where we intended.
 */

import {
  constants,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * Refuse paths that can be redirected or that name a device rather than a
 * file. Checked on every path we are about to write through.
 */
export function assertSafePath(target: string): void {
  // `\\?\` and `\\.\` are checked first: they also begin with `\\`, but they
  // name a device or bypass normal path parsing rather than a share, and the
  // more specific message is the one worth reporting.
  if (target.startsWith("\\\\?\\") || target.startsWith("\\\\.\\")) {
    throw new Error(`refusing device path: ${target}`);
  }
  if (target.startsWith("\\\\") || target.startsWith("//")) {
    throw new Error(`refusing UNC path: ${target}`);
  }
}

/**
 * Resolve a path to its canonical, **long** form.
 *
 * On Windows `fs.realpathSync` resolves symlinks and junctions but leaves 8.3
 * short names alone, so `C:\Users\JOHN~1\...` comes back unchanged. That
 * matters more than it looks: the CLI decides whether a file is inside the
 * working directory by comparing paths, and a short-name cwd makes every file
 * look like it is outside — every `Read`, `Grep` and `Glob` is then denied and
 * the subagent reports it cannot see the workspace at all.
 *
 * `realpathSync.native` goes through the OS and does expand short names.
 */
export function toLongPath(target: string): string {
  try {
    return realpathSync.native(target);
  } catch {
    return realpathSync(target);
  }
}

/**
 * Resolve `candidate` and confirm it stays under `root` after symlinks and
 * junctions are followed. The candidate must already exist.
 */
export function assertWithinRoot(root: string, candidate: string): string {
  assertSafePath(candidate);
  const realRoot = toLongPath(root);
  const realCandidate = toLongPath(candidate);
  const normalizedRoot = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (realCandidate !== realRoot && !realCandidate.startsWith(normalizedRoot)) {
    throw new Error(`path escapes its root: ${candidate} is outside ${root}`);
  }
  return realCandidate;
}

/** Refuse to follow a directory junction or symlink at the final component. */
export function assertNotReparsePoint(target: string): void {
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    return; // does not exist yet, nothing to follow
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`refusing to write through a link: ${target}`);
  }
}

function defaultRoot(): string {
  const override = process.env["QODER_AS_SUBAGENT_STATE_DIR"];
  if (override && override.trim() !== "") return resolve(override);

  if (process.platform === "win32") {
    const localAppData = process.env["LOCALAPPDATA"];
    if (localAppData && localAppData.trim() !== "") {
      return join(localAppData, "qoder-as-subagent");
    }
    return join(homedir(), "AppData", "Local", "qoder-as-subagent");
  }
  const xdg = process.env["XDG_STATE_HOME"];
  if (xdg && xdg.trim() !== "") return join(xdg, "qoder-as-subagent");
  return join(homedir(), ".local", "state", "qoder-as-subagent");
}

export interface StatePaths {
  readonly root: string;
  readonly jobsDir: string;
}

/**
 * Create (or adopt) the state root and return the paths under it.
 *
 * The root is created with owner-only permissions where the platform honours
 * them. Windows inherits the per-user ACL of `%LOCALAPPDATA%`, which is the
 * practical equivalent.
 */
export function ensureStatePaths(): StatePaths {
  const root = defaultRoot();
  assertSafePath(root);

  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertNotReparsePoint(root);

  const jobsDir = join(root, "jobs");
  mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
  assertNotReparsePoint(jobsDir);

  return { root, jobsDir };
}

/** Node's constants, re-exported so callers need not import fs twice. */
export const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC;
