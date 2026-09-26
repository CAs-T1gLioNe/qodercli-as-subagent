/**
 * Logging for a stdio MCP server.
 *
 * stdout carries the MCP transport, so a stray console.log corrupts the
 * protocol stream. Everything here goes to stderr, which the client shows to
 * the user but never parses.
 */

const PREFIX = "[qoder-as-subagent]";

function emit(level: string, message: string, detail?: unknown): void {
  const line =
    detail === undefined
      ? `${PREFIX} ${level} ${message}`
      : `${PREFIX} ${level} ${message} ${safeJson(detail)}`;
  process.stderr.write(line + "\n");
}

function safeJson(value: unknown): string {
  if (value instanceof Error) {
    return JSON.stringify({ name: value.name, message: value.message });
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "<unserializable>";
  }
}

export const log = {
  info(message: string, detail?: unknown): void {
    emit("info", message, detail);
  },
  warn(message: string, detail?: unknown): void {
    emit("warn", message, detail);
  },
  error(message: string, detail?: unknown): void {
    emit("error", message, detail);
  },
};
