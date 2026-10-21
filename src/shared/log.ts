type Level = "info" | "warn" | "error";

/** A log line kept in memory for the page's live log panel. */
export interface LogEvent {
  id: number;
  at: string;
  level: Level;
  msg: string;
}

const MAX_EVENTS = 500;
const events: LogEvent[] = [];
let nextId = 1;

function write(level: Level, msg: string, extra?: unknown) {
  const at = new Date().toISOString();
  const tail = extra === undefined ? "" : ` ${extra instanceof Error ? extra.message : JSON.stringify(extra)}`;
  (level === "info" ? console.log : console.error)(`${at} ${level.toUpperCase()} ${msg}${tail}`);
  events.push({ id: nextId++, at, level, msg: msg + tail });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

export const log = {
  info: (msg: string, extra?: unknown) => write("info", msg, extra),
  warn: (msg: string, extra?: unknown) => write("warn", msg, extra),
  error: (msg: string, extra?: unknown) => write("error", msg, extra),
};

/** Log lines after `id` (all retained ones for 0), oldest first. */
export const eventsSince = (id: number, limit = 300): LogEvent[] => events.filter((e) => e.id > id).slice(-limit);
