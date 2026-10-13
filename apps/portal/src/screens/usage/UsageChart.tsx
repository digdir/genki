import {
  Details,
  DetailsContent,
  DetailsSummary,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useT } from '../../i18n';
import type { Bar, Category } from './model';
import { capitalise, money, nb, short, tokensIn } from './model';

interface Props {
  bars: Bar[];
  cats: Category[];
  selected: number;
  onSelect: (index: number) => void;
  max: number;
  refLine?: { value: number; label: string };
  label: string;
  ticks: string[];
  monthly: boolean;
}

export const UsageChart = ({
  bars,
  cats,
  selected,
  onSelect,
  max,
  refLine,
  label,
  ticks,
  monthly,
}: Props) => {
  const t = useT();
  const f = useFormat();
  const sel = bars[selected];
  return (
    <>
      <ul aria-label={t('usage.legend')} className="usage-legend">
        {cats.map((c) => (
          <li key={c.id}>
            <span aria-hidden="true" className="swatch" style={{ background: c.color }} />
            {c.label}
          </li>
        ))}
      </ul>
      <div className="usage-chart">
        <div aria-hidden="true" className="usage-axis">
          <span>{short(f, t, max)}</span>
          <span>{short(f, t, max / 2)}</span>
          <span>0</span>
        </div>
        <div className="usage-plot">
          {refLine ? (
            <div
              aria-hidden="true"
              className="usage-ref"
              style={{ bottom: `${(refLine.value / max) * 100}%` }}
            >
              <span>{refLine.label}</span>
            </div>
          ) : null}
          <ol aria-label={label} className={monthly ? 'usage-bars monthly' : 'usage-bars'}>
            {bars.map((b, i) => {
              const on = i === selected;
              const segs = cats
                .map((c) => ({ c, t: tokensIn(b.values, c.id) }))
                .filter((s) => s.t > 0);
              return (
                <li key={b.key}>
                  {b.future ? (
                    <span
                      role="img"
                      className="usage-bar future"
                      aria-label={t('usage.barFuture', { period: b.full })}
                    />
                  ) : (
                    <button
                      type="button"
                      className={on ? 'usage-bar selected' : 'usage-bar'}
                      aria-label={t('usage.barTokens', {
                        period: b.full,
                        tokens: short(f, t, b.total),
                      })}
                      aria-pressed={on}
                      onClick={() => onSelect(i)}
                    >
                      <span className="usage-stack" style={{ height: `${(b.total / max) * 100}%` }}>
                        {segs.map((s) => (
                          <span key={s.c.id} style={{ flex: s.t, background: s.c.color }} />
                        ))}
                      </span>
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
        <span />
        <div aria-hidden="true" className="usage-ticks">
          {ticks.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
      </div>
      {sel ? (
        <div aria-live="polite" className="usage-selected">
          <div className="usage-selected-head">
            <span className="usage-selected-title">{capitalise(sel.full)}</span>
            <span className="numeric">
              {t('usage.selectedTotal', {
                tokens: short(f, t, sel.total),
                cost: money(f, t, sel.cost),
              })}
            </span>
          </div>
          <ul>
            {cats.map((c) => (
              <li key={c.id}>
                <span aria-hidden="true" className="swatch" style={{ background: c.color }} />
                <span className="grow">{c.label}</span>
                <span className="numeric">{short(f, t, tokensIn(sel.values, c.id))}</span>
              </li>
            ))}
          </ul>
          <span className="meta-xs">{t('usage.selectBar')}</span>
        </div>
      ) : null}
      <Details>
        <DetailsSummary>{t('usage.showTable')}</DetailsSummary>
        <DetailsContent>
          <div
            className="table-scroll"
            tabIndex={0}
            role="region"
            aria-label={t('usage.tableLabel')}
          >
            <Table data-size="sm">
              <caption className="visually-hidden">{label}</caption>
              <TableHead>
                <TableRow>
                  <TableHeaderCell scope="col">
                    {monthly ? t('usage.month') : t('usage.day')}
                  </TableHeaderCell>
                  {cats.map((c) => (
                    <TableHeaderCell key={c.id} scope="col" className="num">
                      {c.label}
                    </TableHeaderCell>
                  ))}
                  <TableHeaderCell scope="col" className="num">
                    {t('usage.total')}
                  </TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {bars
                  .filter((b) => !b.future)
                  .map((b) => (
                    <TableRow key={b.key}>
                      <TableHeaderCell scope="row">{capitalise(b.full)}</TableHeaderCell>
                      {cats.map((c) => (
                        <TableCell key={c.id} className="num">
                          {nb(f, tokensIn(b.values, c.id))}
                        </TableCell>
                      ))}
                      <TableCell className="num">{nb(f, b.total)}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
        </DetailsContent>
      </Details>
    </>
  );
};
