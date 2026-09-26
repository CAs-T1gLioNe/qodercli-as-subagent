/**
 * Workspace validation.
 *
 * Every one of the reference implementations let the caller name any directory
 * on the machine. Two things follow from that, and both are real:
 *
 *  - **A path out of the workspace is a path out of the policy.** A caller that
 *    can point the subagent at `C:\` has escaped whatever confinement the tier
 *    was supposed to provide.
 *  - **Trust is persistent.** The CLI keys workspace trust on the git root and
 *    remembers it in the user's config, so a directory the user once accepted
 *    interactively carries that directory's own `permissions.allow` into a
 *    non-interactive run.
 *
 * So the allowlist is server configuration, never a per-call argument: the
 * caller chooses among roots the operator already blessed, not among all
 * directories that exist.
 */

import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve, sep } from "node:path";

import { assertSafePath, toLongPath } from "./state-dir.js";

export class WorkspaceError extends Error {
  override readonly name = "WorkspaceError";
}

/**
 * Roots the operator has blessed.
 *
 * `QODER_AS_SUBAGENT_WORKSPACE_ROOTS` is a path-delimiter-separated list. When it
 * is unset the server's own working directory is the single root, which is the
 * directory the client launched us in and therefore the one it cares about.
 */
export function allowedRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env["QODER_AS_SUBAGENT_WORKSPACE_ROOTS"];
  const configured =
    raw === undefined || raw.trim() === ""
      ? [process.cwd()]
      : raw.split(delimiter).map((p) => p.trim()).filter((p) => p !== "");

  const roots: string[] = [];
  for (const entry of configured) {
    if (!isAbsolute(entry)) {
      throw new WorkspaceError(`workspace root must be absolute: ${entry}`);
    }
    assertSafePath(entry);
    if (!existsSync(entry)) {
      throw new WorkspaceError(`workspace root does not exist: ${entry}`);
    }
    const real = toLongPath(entry);
    if (!statSync(real).isDirectory()) {
      throw new WorkspaceError(`workspace root is not a directory: ${entry}`);
    }
    roots.push(real);
  }
  if (roots.length === 0) {
    throw new WorkspaceError("no workspace roots configured");
  }
  return roots;
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : root + sep;
  return candidate === root || candidate.startsWith(normalizedRoot);
}

/**
 * Resolve a caller-supplied workspace to a real path inside an allowed root.
 *
 * Rejects, in order: UNC and device paths (they can leak Windows credentials to
 * a remote host, and `\\?\` bypasses normal path parsing), relative paths, a
 * path that does not exist, a non-directory, a symlink or junction escape, and
 * anything outside every configured root.
 */
export function resolveWorkspace(requested: unknown): string {
  if (typeof requested !== "string" || requested.trim() === "") {
    throw new WorkspaceError("workspace is required");
  }
  const candidate = requested.trim();

  // A network path can send the machine's credentials to whatever host it
  // names; `\\?\` and `\\.\` sidestep normal path handling entirely.
  if (candidate.startsWith("\\\\") || candidate.startsWith("//")) {
    throw new WorkspaceError(`refusing a network path: ${candidate}`);
  }
  assertSafePath(candidate);

  if (!isAbsolute(candidate)) {
    throw new WorkspaceError(`workspace must be an absolute path: ${candidate}`);
  }
  // Deliberately not created: a typo should fail, not silently make a directory.
  if (!existsSync(candidate)) {
    throw new WorkspaceError(`workspace does not exist: ${candidate}`);
  }

  let real: string;
  try {
    real = toLongPath(candidate);
  } catch (error) {
    throw new WorkspaceError(
      `workspace could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!statSync(real).isDirectory()) {
    throw new WorkspaceError(`workspace is not a directory: ${candidate}`);
  }

  const roots = allowedRoots();
  if (!roots.some((root) => isWithin(root, real))) {
    throw new WorkspaceError(
      `workspace is outside every allowed root: ${real} ` +
        `(allowed: ${roots.join(", ")}; set QODER_AS_SUBAGENT_WORKSPACE_ROOTS to widen)`,
    );
  }
  return real;
}

/** Describe the roots for the startup log, without leaking anything else. */
export function describeRoots(): string {
  try {
    return allowedRoots().join(", ");
  } catch (error) {
    return `<invalid: ${error instanceof Error ? error.message : String(error)}>`;
  }
}

export { resolve as resolvePath };
