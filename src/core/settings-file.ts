/**
 * The `--settings` file handed to each run.
 *
 * `--settings` takes a path, so the deny rules have to reach disk. It is
 * written under the same per-user root as job state rather than the system temp
 * directory — on Windows `%TEMP%` is commonly readable by other accounts, and
 * the file is a description of the security policy.
 *
 * The file is created fresh per run and removed when the run ends, so a stale
 * policy can never be picked up by a later invocation.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildSettings, type Tier } from "./policy.js";
import { assertNotReparsePoint, ensureStatePaths } from "./state-dir.js";

export interface SettingsHandle {
  readonly path: string;
  dispose(): void;
}

export function writeSettingsFile(tier: Tier): SettingsHandle {
  const { root } = ensureStatePaths();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  assertNotReparsePoint(runDir);

  const dir = mkdtempSync(join(runDir, "policy-"));
  const path = join(dir, "settings.json");
  // Owner-only: on Windows this inherits the per-user ACL of the parent.
  writeFileSync(path, JSON.stringify(buildSettings(tier), null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });

  let disposed = false;
  return {
    path,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
