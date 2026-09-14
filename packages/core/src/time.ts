/** 时间戳工具：ms / ISO / alink 本地时间串 互转 */

export function msToIso(ms?: number | null): string | undefined {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

export function isoToMs(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.round(value) : Math.round(value * 1000);
  }
  const s = String(value).trim();
  if (!s) return undefined;
  // pure digits
  if (/^\d{13}$/.test(s)) return Number(s);
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  // "2026-07-03 17:25:05" 本地时间
  const local = s.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/,
  );
  if (local) {
    const [, y, mo, d, h, mi, sec, frac] = local;
    const msPart = frac ? Number(frac.padEnd(3, "0").slice(0, 3)) : 0;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec), msPart);
    return dt.getTime();
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

/** alink 库使用本地时间字符串 */
export function msToAlinkStr(ms?: number | null): string | undefined {
  if (ms == null || ms <= 0) return undefined;
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

export function nowMs(): number {
  return Date.now();
}

export function timestampTag(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}
