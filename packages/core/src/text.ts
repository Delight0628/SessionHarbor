/** 文本清洗：剥离 system-reminder 注入块等噪音 */

const REMINDER_RE = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>\s*/g;

export function stripReminders(text: string): string {
  return text.replace(REMINDER_RE, "").trim();
}

export function stripAllReminders(items: Array<{ role: string; content: string }>): Array<{ role: string; content: string }> {
  return items
    .map((m) =>
      m.role === "user" ? { ...m, content: stripReminders(m.content) } : m,
    )
    .filter((m) => m.content.trim().length > 0);
}
