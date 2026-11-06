import { intlLocale, type Format, type Locale } from '@genai/i18n';

// Calendar days in the zone the platform formats every time in, so «i går» means the day before
// on the clock the reader reads, and a day of 23 or 25 hours counts as one.
const timeZone = 'Europe/Oslo';
const msPerDay = 86_400_000;

const dayParts = new Intl.DateTimeFormat('en-CA', {
  timeZone,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});

const daySerial = (date: Date) => {
  const parts = dayParts.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(part('year'), part('month') - 1, part('day')) / msPerDay;
};

// Built once per locale: a long thread formats a time for every answer on every render.
const dayMonthFormats = new Map<Locale, Intl.DateTimeFormat>();
const dayMonth = (locale: Locale) => {
  let format = dayMonthFormats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(intlLocale(locale), {
      timeZone,
      day: 'numeric',
      month: 'short',
    });
    dayMonthFormats.set(locale, format);
  }
  return format;
};

export interface AnswerTimeText {
  /** Short, as the thread list writes a row's time. */
  text: string;
  /** For the `datetime` attribute. */
  dateTime: string;
  /** The whole date and time: the `title`, and what a screen reader hears. */
  title: string;
}

/**
 * When an answer came, as kunnskapsassistenten writes it: the clock today, «i går», the weekday
 * this week, then day and short month. The short text leaves out the year, so the whole date goes
 * with it. `undefined` for a time that cannot be read: no time is better than «Invalid Date».
 */
export const answerTime = (
  value: string | number | Date,
  f: Format,
  yesterday: string,
  now: Date = new Date(),
): AnswerTimeText | undefined => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const days = daySerial(now) - daySerial(date);
  const common = { dateTime: date.toISOString(), title: f.dateTime(date) };
  // A time ahead of the machine's clock reads as today: the answer does not argue with the clock.
  if (days <= 0) return { ...common, text: f.time(date) };
  if (days === 1) return { ...common, text: yesterday };
  if (days < 7) return { ...common, text: f.weekday(date) };
  return { ...common, text: dayMonth(f.locale).format(date) };
};
