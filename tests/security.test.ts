import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sanitizeEnv, summaryOf } from "../src/core/env.js";
import { writeSettingsFile } from "../src/core/settings-file.js";
import { allowedRoots, resolveWorkspace, WorkspaceError } from "../src/core/workspace.js";
import { assertSafePath } from "../src/core/state-dir.js";

let scratch: string;
const saved: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ccas-sec-"));
  setEnv("QODER_AS_SUBAGENT_WORKSPACE_ROOTS", scratch);
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const key of Object.keys(saved)) delete saved[key];
  rmSync(scratch, { recursive: true, force: true });
});

describe("sanitizeEnv", () => {
  it("drops every credential-bearing and behaviour-changing variable", () => {
    const { env, dropped } = sanitizeEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT: "1",
      CLAUDE_CONFIG_DIR: "/tmp/elsewhere",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      NODE_OPTIONS: "--require ./payload.js",
      NODE_REPL_EXTERNAL_MODULE: "./payload.js",
      BASH_ENV: "./payload.sh",
      HTTPS_PROXY: "http://proxy",
      AWS_SECRET_ACCESS_KEY: "aws",
      GH_TOKEN: "ghp_x",
      KUBECONFIG: "/home/u/.kube/config",
      LD_PRELOAD: "./evil.so",
    });

    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/home/u");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT");
    expect(env).not.toHaveProperty("NODE_OPTIONS");
    expect(env).not.toHaveProperty("BASH_ENV");
    expect(env).not.toHaveProperty("GIT_CONFIG_COUNT");
    expect(env).not.toHaveProperty("HTTPS_PROXY");
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(env).not.toHaveProperty("KUBECONFIG");
    expect(env).not.toHaveProperty("LD_PRELOAD");

    expect(dropped).toContain("NODE_OPTIONS");
    expect(dropped).toContain("CLAUDE_CONFIG_DIR");
  });

  it("keeps a subscription login off the API key by default", () => {
    // An inherited API key would silently bill the API instead of using the
    // subscription that is already logged in on disk.
    const { env, passedThrough } = sanitizeEnv({ ANTHROPIC_API_KEY: "sk-ant-x" });
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(passedThrough).toEqual([]);
  });

  it("passes the API key only when explicitly asked", () => {
    const { env, passedThrough } = sanitizeEnv({
      ANTHROPIC_API_KEY: "sk-ant-x",
      QODER_AS_SUBAGENT_USE_API_KEY: "1",
    });
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-ant-x");
    expect(passedThrough).toContain("ANTHROPIC_API_KEY");
  });

  it("passes through only the names the operator listed", () => {
    const { env, dropped } = sanitizeEnv({
      QODER_AS_SUBAGENT_PASSTHROUGH: "HTTPS_PROXY, NO_PROXY",
      HTTPS_PROXY: "http://proxy",
      NO_PROXY: "localhost",
      HTTP_PROXY: "http://other",
    });
    expect(env["HTTPS_PROXY"]).toBe("http://proxy");
    expect(env["NO_PROXY"]).toBe("localhost");
    expect(env).not.toHaveProperty("HTTP_PROXY");
    expect(dropped).toContain("HTTP_PROXY");
  });

  it("never reports values, only names", () => {
    const summary = summaryOf(
      sanitizeEnv({ ANTHROPIC_API_KEY: "sk-ant-super-secret", PATH: "/usr/bin" }),
    );
    expect(JSON.stringify(summary)).not.toContain("super-secret");
  });
});

describe("resolveWorkspace", () => {
  it("accepts a directory inside an allowed root", () => {
    const inner = join(scratch, "project");
    mkdirSync(inner);
    expect(resolveWorkspace(inner)).toBe(realpathish(inner));
  });

  it("accepts the root itself", () => {
    expect(resolveWorkspace(scratch)).toBe(realpathish(scratch));
  });

  it("returns a long-form path, never an 8.3 short name", () => {
    // fs.realpathSync leaves `C:\Users\JOHN~1\...` alone on Windows, and
    // Claude Code decides whether a file is inside the working directory by
    // comparing paths. A short-name cwd makes every file look like it is
    // outside, so Read/Grep/Glob are all denied and the subagent cannot see
    // the workspace at all.
    const inner = join(scratch, "project");
    mkdirSync(inner);
    const resolved = resolveWorkspace(inner);
    expect(resolved).not.toMatch(/~\d/);
    expect(resolved).toBe(realpathSync.native(inner));
  });

  it("refuses a directory outside every root", () => {
    const outside = mkdtempSync(join(tmpdir(), "ccas-outside-"));
    try {
      expect(() => resolveWorkspace(outside)).toThrow(/outside every allowed root/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses network and device paths", () => {
    // A network path can hand this machine's credentials to the host it names.
    expect(() => resolveWorkspace("\\\\server\\share")).toThrow(/network path/);
    expect(() => resolveWorkspace("//server/share")).toThrow(/network path/);
    expect(() => assertSafePath("\\\\?\\C:\\Windows")).toThrow(/UNC|device/);
    expect(() => assertSafePath("\\\\.\\PHYSICALDRIVE0")).toThrow(/device/);
  });

  it("refuses a relative path rather than resolving it against the cwd", () => {
    expect(() => resolveWorkspace("./project")).toThrow(/absolute/);
  });

  it("refuses a path that does not exist, and does not create it", () => {
    const missing = join(scratch, "nope");
    expect(() => resolveWorkspace(missing)).toThrow(/does not exist/);
    expect(() => resolveWorkspace(missing)).toThrow();
  });

  it("refuses a file", () => {
    const file = join(scratch, "a.txt");
    writeFileSyncSafe(file);
    expect(() => resolveWorkspace(file)).toThrow(/not a directory/);
  });

  it("refuses an empty or non-string workspace", () => {
    expect(() => resolveWorkspace("")).toThrow(WorkspaceError);
    expect(() => resolveWorkspace(undefined)).toThrow(WorkspaceError);
    expect(() => resolveWorkspace(42)).toThrow(WorkspaceError);
  });

  it("refuses a link that escapes the allowed root", () => {
    const outside = mkdtempSync(join(tmpdir(), "ccas-target-"));
    try {
      const link = join(scratch, "escape");
      try {
        symlinkSync(outside, link, "junction");
      } catch {
        return; // creating the link needs privileges here; nothing to test
      }
      expect(() => resolveWorkspace(link)).toThrow(/outside every allowed root/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses to start when a configured root is relative or missing", () => {
    setEnv("QODER_AS_SUBAGENT_WORKSPACE_ROOTS", "relative/path");
    expect(() => allowedRoots()).toThrow(/absolute/);

    setEnv("QODER_AS_SUBAGENT_WORKSPACE_ROOTS", join(scratch, "gone"));
    expect(() => allowedRoots()).toThrow(/does not exist/);
  });
});

describe("writeSettingsFile", () => {
  it("writes the deny rules and removes them on dispose", () => {
    const handle = writeSettingsFile("consult");
    const body = JSON.parse(readText(handle.path)) as { permissions: { deny: string[] } };
    expect(body.permissions.deny.length).toBeGreaterThan(10);
    expect(body.permissions.deny).toContain("Read(~/.ssh/**)");

    const dir = handle.path.replace(/[\\/][^\\/]+$/, "");
    handle.dispose();
    expect(existsSyncSafe(dir)).toBe(false);
  });

  it("gives a different file to each run", () => {
    const a = writeSettingsFile("consult");
    const b = writeSettingsFile("execute");
    expect(a.path).not.toBe(b.path);
    a.dispose();
    b.dispose();
  });
});

const realpathish = (p: string): string => realpathSync.native(p);
const writeFileSyncSafe = (p: string): void => writeFileSync(p, "x");
const readText = (p: string): string => readFileSync(p, "utf8");
const existsSyncSafe = (p: string): boolean => existsSync(p);
