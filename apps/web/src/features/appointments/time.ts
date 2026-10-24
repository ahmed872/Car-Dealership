/**
 * Calendar arithmetic in the company's time zone. Business dates are 'YYYY-MM-DD' strings; an
 * appointment's instants are converted to wall-clock time in the tenant zone (not the browser's),
 * so a branch in Riyadh sees the same day and hour wherever the user's laptop is set.
 */

const MINUTE = 60_000;

function parts(at: Date, tz: string) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const g = (type: string) => Number(p.find((x) => x.type === type)?.value ?? '0');
  return { y: g('year'), m: g('month'), d: g('day'), hh: g('hour') % 24, mm: g('minute'), ss: g('second') };
}

/** Offset of the zone from UTC at an instant, in ms (Riyadh: +3h). */
function offsetMs(at: Date, tz: string): number {
  const p = parts(at, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The instant of a wall-clock date + time ('HH:MM') in the zone. */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, hh!, mm!);
  const off = offsetMs(new Date(guess), tz);
  let res = guess - off;
  const off2 = offsetMs(new Date(res), tz);
  if (off2 !== off) res = guess - off2;
  return new Date(res);
}

/** Wall-clock date ('YYYY-MM-DD'), time ('HH:MM') and minutes since midnight of an instant in the zone. */
export function zoned(at: Date | string, tz: string): { date: string; time: string; minutes: number } {
  const p = parts(typeof at === 'string' ? new Date(at) : at, tz);
  return { date: `${p.y}-${pad(p.m)}-${pad(p.d)}`, time: `${pad(p.hh)}:${pad(p.mm)}`, minutes: p.hh * 60 + p.mm };
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

/** First day of the week containing `date`. */
export function startOfWeek(date: string, firstDay: number): string {
  const diff = (weekday(date) - firstDay + 7) % 7;
  return addDays(date, -diff);
}

/** Week start by market: Saturday (EG), Sunday (SA), Monday (AE, Mon–Fri work week). */
export function firstDayOfWeek(market: string | undefined): number {
  if (market === 'EG') return 6;
  if (market === 'AE') return 1;
  return 0;
}

const locale = (lang: string) => (lang === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn');

/** "Sat 18 Oct" style label of a business date. */
export function dayLabel(date: string, lang: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat(locale(lang), { ...opts, timeZone: 'UTC' }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

/** Clock time of an instant in the zone, e.g. "03:30 م" / "15:30". */
export function timeLabel(at: Date | string, tz: string, lang: string): string {
  return new Intl.DateTimeFormat(locale(lang), { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(typeof at === 'string' ? new Date(at) : at);
}

/** "09:00" label for an hour of the day grid. */
export function hourLabel(hour: number, lang: string): string {
  return new Intl.DateTimeFormat(locale(lang), { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, 0, 1, hour)));
}

/** Minutes between two 'HH:MM' strings. */
export function minutesBetween(start: string, end: string): number {
  const [a, b] = start.split(':').map(Number);
  const [c, e] = end.split(':').map(Number);
  return c! * 60 + e! - (a! * 60 + b!);
}

/** 'HH:MM' plus minutes (clamped to 23:59). */
export function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number);
  const total = Math.min(23 * 60 + 59, Math.max(0, h! * 60 + m! + minutes));
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** The next quarter hour from now in the zone. */
export function nextQuarter(tz: string): { date: string; time: string } {
  const now = new Date(Math.ceil(Date.now() / (15 * MINUTE)) * 15 * MINUTE);
  const z = zoned(now, tz);
  return { date: z.date, time: z.time };
}

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
