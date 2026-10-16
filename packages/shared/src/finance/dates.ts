/** Pure calendar-date helpers on ISO "YYYY-MM-DD" strings (no time zones involved). */
export const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function parseIsoDate(s: string): { y: number; m: number; d: number } {
  if (!ISO_DATE_REGEX.test(s)) throw new Error(`Invalid ISO date: ${s}`);
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new Error(`Invalid calendar date: ${s}`);
  }
  return { y, m, d };
}

export function formatIsoDate(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Adds months keeping the anchor day, clamped to month end (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(iso: string, months: number, anchorDay?: number): string {
  const { y, m, d } = parseIsoDate(iso);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const day = Math.min(anchorDay ?? d, daysInMonth(ny, nm));
  return formatIsoDate(ny, nm, day);
}

export function addDays(iso: string, days: number): string {
  const { y, m, d } = parseIsoDate(iso);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return formatIsoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function diffDays(fromIso: string, toIso: string): number {
  const a = parseIsoDate(fromIso);
  const b = parseIsoDate(toIso);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}

/** Today's calendar date in an IANA time zone (e.g. "Asia/Riyadh"). */
export function todayInZone(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => ((acc[p.type] = p.value), acc), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
