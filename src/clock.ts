/**
 * Household clock.
 *
 * Hearth reasons about "now" in the care recipient's home time zone. For demos and
 * tests the clock can be pinned to a fixed instant or shifted by an offset, so a
 * missed-dose escalation can be shown in a 3-minute video instead of waiting an hour.
 */
export class Clock {
  private offsetMs = 0;
  private pinned: number | null = null;

  constructor(public readonly timeZone: string) {}

  now(): Date {
    return new Date(this.pinned ?? Date.now() + this.offsetMs);
  }

  /** Pin the clock to an instant (ISO string or a local "HH:MM" today in the household zone). */
  set(value: string): Date {
    const target = /^\d{1,2}:\d{2}$/.test(value)
      ? localTimeToday(this.timeZone, value, new Date(Date.now() + this.offsetMs))
      : new Date(value);
    if (Number.isNaN(target.getTime())) throw new Error(`Invalid time: ${value}`);
    this.pinned = target.getTime();
    return this.now();
  }

  advance(minutes: number): Date {
    if (this.pinned !== null) this.pinned += minutes * 60_000;
    else this.offsetMs += minutes * 60_000;
    return this.now();
  }

  reset(): void {
    this.offsetMs = 0;
    this.pinned = null;
  }

  isAdjusted(): boolean {
    return this.pinned !== null || this.offsetMs !== 0;
  }
}

/** Parts of a Date as seen in a given IANA time zone. */
export function zonedParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour) % 24;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour,
    minute: Number(parts.minute),
    minutesOfDay: hour * 60 + Number(parts.minute),
    weekday: parts.weekday as string,
  };
}

/** Offset (ms) of a time zone relative to UTC at a given instant. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const [y, m, d] = p.date.split("-").map(Number);
  const asUtc = Date.UTC(y, m - 1, d, p.hour, p.minute);
  return asUtc - Math.floor(date.getTime() / 60_000) * 60_000;
}

/** The instant at which the household's local clock reads `hhmm` on `localDate` (YYYY-MM-DD). */
export function localInstant(timeZone: string, localDate: string, hhmm: string): Date {
  const [y, m, d] = localDate.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const offset = zoneOffsetMs(guess, timeZone);
  return new Date(guess.getTime() - offset);
}

export function localTimeToday(timeZone: string, hhmm: string, ref: Date): Date {
  return localInstant(timeZone, zonedParts(ref, timeZone).date, hhmm);
}

export function addDays(localDate: string, days: number): string {
  const [y, m, d] = localDate.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

export function formatTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date);
}

export function hhmmToLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}
