type Level = "info" | "warn" | "error";

function write(level: Level, msg: string, extra?: unknown) {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}`;
  const tail = extra === undefined ? "" : ` ${extra instanceof Error ? extra.message : JSON.stringify(extra)}`;
  (level === "info" ? console.log : console.error)(line + tail);
}

export const log = {
  info: (msg: string, extra?: unknown) => write("info", msg, extra),
  warn: (msg: string, extra?: unknown) => write("warn", msg, extra),
  error: (msg: string, extra?: unknown) => write("error", msg, extra),
};
