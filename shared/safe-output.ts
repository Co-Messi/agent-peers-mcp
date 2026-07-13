export function sanitizeTerminalText(value: unknown, maxChars = 4_096): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .slice(0, maxChars);
}
