import { Button, Field, Input, Label } from '@digdir/designsystemet-react';
import { intlLocale } from '@genai/i18n';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { addDays } from './filters';

const datePattern = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;

export const dayText = (day: string) => {
  const [y, m, d] = day.split('-');
  return day ? `${d}.${m}.${y}` : '';
};

export const parseDayText = (text: string) => {
  const match = datePattern.exec(text.trim());
  if (!match) return undefined;
  const [, d = '', m = '', y = ''] = match;
  const day = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return addDays(day, 0) === day ? day : undefined;
};

const monthOf = (day: string) => `${day.slice(0, 7)}-01`;

const Calendar = ({
  from,
  to,
  today,
  onPick,
  onClose,
}: {
  from: string;
  to: string;
  today: string;
  onPick: (from: string, to: string) => void;
  onClose: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const [month, setMonth] = useState(monthOf(to || today));
  const [first, setFirst] = useState<string | undefined>();
  const locale = intlLocale(f.locale);
  const monthName = new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${month}T00:00:00Z`));
  const dayName = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  const lead = (new Date(`${month}T00:00:00Z`).getUTCDay() + 6) % 7;
  const days: string[] = [];
  for (let d = month; d.slice(0, 7) === month.slice(0, 7); d = addDays(d, 1)) days.push(d);
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    weekday.format(new Date(Date.UTC(2026, 10, 2 + i))).replace('.', ''),
  );
  const lo = first ?? from;
  const hi = first ?? to;

  return (
    <div
      role="dialog"
      aria-label={t('logRuns.calendar', { month: monthName })}
      className="log-calendar"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="log-calendar-head">
        <strong>{monthName}</strong>
        <Button type="button" variant="tertiary" data-size="sm" onClick={onClose}>
          {t('logRuns.calendarClose')}
        </Button>
      </div>
      <div className="log-calendar-head">
        <Button
          type="button"
          variant="tertiary"
          data-size="sm"
          onClick={() => setMonth(monthOf(addDays(month, -1)))}
        >
          {t('logRuns.previousMonth')}
        </Button>
        <Button
          type="button"
          variant="tertiary"
          data-size="sm"
          disabled={month >= monthOf(today)}
          onClick={() => setMonth(monthOf(addDays(month, 32)))}
        >
          {t('logRuns.nextMonth')}
        </Button>
      </div>
      <p className="meta">{first ? t('logRuns.calendarLast') : t('logRuns.calendarFirst')}</p>
      <div className="log-calendar-grid" aria-hidden="true">
        {weekdays.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="log-calendar-grid">
        {Array.from({ length: lead }, (_, i) => (
          <span key={`lead-${i}`} />
        ))}
        {days.map((d) => {
          const future = d > today;
          const name = dayName.format(new Date(`${d}T00:00:00Z`));
          const inRange = Boolean(lo && hi && d >= lo && d <= hi);
          const edge = d === lo || d === hi;
          return (
            <button
              key={d}
              type="button"
              aria-label={future ? t('logRuns.dayUnavailable', { day: name }) : name}
              aria-pressed={inRange}
              aria-disabled={future || undefined}
              className={`log-calendar-day${edge ? ' edge' : inRange ? ' in-range' : ''}${d === today ? ' today' : ''}`}
              onClick={() => {
                if (future) return;
                if (!first) {
                  setFirst(d);
                  return;
                }
                setFirst(undefined);
                onPick(d < first ? d : first, d < first ? first : d);
              }}
            >
              {Number(d.slice(8))}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export const DateRange = ({
  from,
  to,
  today,
  onChange,
}: {
  from: string;
  to: string;
  today: string;
  onChange: (from: string, to: string) => void;
}) => {
  const t = useT();
  const [text, setText] = useState({ from: dayText(from), to: dayText(to) });
  const [open, setOpen] = useState(false);
  useEffect(() => setText({ from: dayText(from), to: dayText(to) }), [from, to]);

  const typed = useRef(text);
  typed.current = text;
  const type = (key: 'from' | 'to', value: string) => {
    const next = { ...typed.current, [key]: value };
    typed.current = next;
    setText(next);
    const a = parseDayText(next.from);
    const b = parseDayText(next.to);
    if (a && b) onChange(a, b);
  };

  return (
    <div className="log-range">
      <Field data-size="sm">
        <Label htmlFor="lg-from">{t('logRuns.from')}</Label>
        <Input
          id="lg-from"
          inputMode="numeric"
          aria-describedby="lg-datehelp"
          value={text.from}
          onChange={(e) => type('from', e.target.value)}
        />
      </Field>
      <Field data-size="sm">
        <Label htmlFor="lg-to">{t('logRuns.to')}</Label>
        <Input
          id="lg-to"
          inputMode="numeric"
          aria-describedby="lg-datehelp"
          value={text.to}
          onChange={(e) => type('to', e.target.value)}
        />
      </Field>
      <Button
        type="button"
        variant="secondary"
        data-size="sm"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {t('logRuns.pickInCalendar')}
      </Button>
      <span id="lg-datehelp" className="meta log-range-help">
        {t('logRuns.dateHelp')}
      </span>
      {open ? (
        <Calendar
          from={from}
          to={to}
          today={today}
          onPick={(a, b) => {
            setOpen(false);
            onChange(a, b);
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
};
