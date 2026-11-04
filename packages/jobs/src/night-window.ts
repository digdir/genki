import { alwaysNightWindow, defaultNightWindow, nightWindowPattern } from '@genai/definitions';

/** `knowledge.nightWindow` is written as "HH:MM-HH:MM" in this zone (ADR 0042, "Heavy work"). */
export const nightWindowZone = 'Europe/Oslo';

interface Window {
  start: number;
  end: number;
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export const parseNightWindow = (window: string): Window => {
  if (!nightWindowPattern.test(window))
    throw new Error(`a night window is written as 01:00-06:00, got ${window}`);
  const [start = '', end = ''] = window.split('-');
  if (start === end) throw new Error('a night window cannot start and end at the same time');
  return { start: minutes(start), end: minutes(end) };
};

const zoned = new Intl.DateTimeFormat('en-GB', {
  timeZone: nightWindowZone,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const localParts = (at: Date) => {
  const parts = Object.fromEntries(
    zoned.formatToParts(at).map((part) => [part.type, Number(part.value)]),
  ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
  return parts;
};

/** Milliseconds the zone is ahead of UTC at this instant. */
const offsetAt = (at: Date) => {
  const p = localParts(at);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
};

/** The instant a wall-clock time in Oslo falls on; two passes settle a change of offset. */
const instantOf = (year: number, month: number, day: number, minuteOfDay: number) => {
  const wall = Date.UTC(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  const first = wall - offsetAt(new Date(wall));
  return new Date(wall - offsetAt(new Date(first)));
};

const always = (window: string) => window === alwaysNightWindow;

export const inNightWindow = (window: string, at: Date) => {
  if (always(window)) return true;
  const { start, end } = parseNightWindow(window);
  const p = localParts(at);
  const now = p.hour * 60 + p.minute;
  return start < end ? now >= start && now < end : now >= start || now < end;
};

/** The first window start at or after `at`. */
export const nextNightWindowStart = (window: string, at: Date) => {
  if (always(window)) return at;
  const { start } = parseNightWindow(window);
  const p = localParts(at);
  for (let day = 0; day < 3; day += 1) {
    const candidate = instantOf(p.year, p.month, p.day + day, start);
    if (candidate.getTime() >= at.getTime()) return candidate;
  }
  throw new Error('no night window start within two days');
};

/** When heavy work sent at `at` may start: at once inside the window, else at its next start. */
export const heavyWorkStart = (window: string, at: Date) =>
  inNightWindow(window, at) ? at : nextNightWindowStart(window, at);

/** The first window end after `at`, or nothing when the window is `always`. */
export const nightWindowEnd = (window: string, at: Date): Date | undefined => {
  if (always(window)) return undefined;
  const { end } = parseNightWindow(window);
  const p = localParts(at);
  for (let day = 0; day < 3; day += 1) {
    const candidate = instantOf(p.year, p.month, p.day + day, end);
    if (candidate.getTime() > at.getTime()) return candidate;
  }
  throw new Error('no night window end within two days');
};

/** The cron line of the nightly checks: the window's start, or the default start for `always`. */
export const nightlyCron = (window: string) => {
  const { start } = parseNightWindow(always(window) ? defaultNightWindow : window);
  return `${start % 60} ${Math.floor(start / 60)} * * *`;
};
