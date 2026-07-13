type LogValue = string | number | boolean | null | undefined;
type LogFields = Record<string, LogValue>;
type Writer = (line: string) => void;

const REDACTED_KEY = /secret|token|password|authorization|message|text|body|cwd|path|git_root|filename/i;

function sanitizeString(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\/(?:Users|home)\/[^\s"']+/g, "[local-path]")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .slice(0, 1_024);
}

function safeFields(fields: LogFields): Record<string, string | number | boolean | null> {
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    safe[key] = REDACTED_KEY.test(key)
      ? "[redacted]"
      : typeof value === "string" ? sanitizeString(value) : value;
  }
  return safe;
}

export function createLogger(component: string, writer: Writer = console.error) {
  const emit = (level: "info" | "warn" | "error", event: string, fields: LogFields = {}) => {
    writer(JSON.stringify({
      timestamp: new Date().toISOString(),
      component,
      level,
      event: event.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80),
      ...safeFields(fields),
    }));
  };
  return {
    info: (event: string, fields?: LogFields) => emit("info", event, fields),
    warn: (event: string, fields?: LogFields) => emit("warn", event, fields),
    error: (event: string, fields?: LogFields) => emit("error", event, fields),
  };
}
