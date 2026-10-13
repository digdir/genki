export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

interface Field {
  values: Set<number>;
  restricted: boolean;
}

export interface Cron {
  minute: Field;
  hour: Field;
  day: Field;
  month: Field;
  weekday: Field;
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

const parseField = (text: string, min: number, max: number, name: string): Field => {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new CronError(`not a valid ${name} field: ${text}`);
    const step = match[4] === undefined ? 1 : Number(match[4]);
    const from = match[1] === '*' ? min : Number(match[2]);
    const to =
      match[1] === '*' ? max : match[3] === undefined ? (match[4] ? max : from) : Number(match[3]);
    if (step < 1 || from < min || to > max || from > to)
      throw new CronError(`${name} out of range in ${text}`);
    for (const v of range(from, to)) if ((v - from) % step === 0) values.add(v);
  }
  return { values, restricted: text !== '*' };
};

export const parseCron = (expression: string): Cron => {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new CronError('a cron expression has five fields');
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  const dow = parseField(weekday.replace(/\b7\b/g, '0'), 0, 6, 'weekday');
  return {
    minute: parseField(minute, 0, 59, 'minute'),
    hour: parseField(hour, 0, 23, 'hour'),
    day: parseField(day, 1, 31, 'day'),
    month: parseField(month, 1, 12, 'month'),
    weekday: dow,
  };
};

const partsIn = (date: Date, timeZone: string) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: weekdays.indexOf(parts.weekday as string),
  };
};

const offsetAt = (utc: number, timeZone: string) => {
  const p = partsIn(new Date(utc), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(utc / 60_000) * 60_000;
};

const localToUtc = (y: number, mo: number, d: number, h: number, mi: number, timeZone: string) => {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offsetAt(guess, timeZone);
  const second = guess - offsetAt(first, timeZone);
  const check = partsIn(new Date(second), timeZone);
  return check.hour === h && check.minute === mi && check.day === d ? second : undefined;
};

const dayMatches = (cron: Cron, day: number, weekday: number) => {
  const byDay = cron.day.values.has(day);
  const byWeekday = cron.weekday.values.has(weekday);
  if (cron.day.restricted && cron.weekday.restricted) return byDay || byWeekday;
  return byDay && byWeekday;
};

export const nextRun = (cron: Cron, after: Date, timeZone = 'Europe/Oslo'): Date => {
  const start = partsIn(new Date(after.getTime() + 60_000), timeZone);
  const hours = [...cron.hour.values].sort((a, b) => a - b);
  const minutes = [...cron.minute.values].sort((a, b) => a - b);
  let cursor = Date.UTC(start.year, start.month - 1, start.day);
  for (let i = 0; i < 366 * 8; i += 1, cursor += 86_400_000) {
    const date = new Date(cursor);
    const y = date.getUTCFullYear();
    const mo = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    if (!cron.month.values.has(mo) || !dayMatches(cron, d, date.getUTCDay())) continue;
    for (const h of hours)
      for (const mi of minutes) {
        const utc = localToUtc(y, mo, d, h, mi, timeZone);
        if (utc !== undefined && utc > after.getTime()) return new Date(utc);
      }
  }
  throw new CronError('the expression never fires');
};
