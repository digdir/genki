import {
  Heading,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useT } from '../../i18n';
import type { UsageReport, UsageSourceId } from '../../types';
import { costOf, money, nb, percentText, tokensOf } from './model';

export const UsageSources = ({ report }: { report: UsageReport }) => {
  const t = useT();
  const f = useFormat();
  const sources = report.totals.bySource;
  if (!sources) return null;
  const total = tokensOf(report.totals);
  const name = (source: UsageSourceId | undefined) =>
    t(source === 'gateway' ? 'usage.sourceGateway' : 'usage.sourceGenki');
  return (
    <section aria-labelledby="kilde-h" className="stack-sm">
      <Heading level={2} data-size="sm" id="kilde-h">
        {t('usage.bySource')}
      </Heading>
      <div className="table-scroll" tabIndex={0} role="region" aria-labelledby="kilde-h">
        <Table border className="usage-table">
          <TableHead>
            <TableRow>
              <TableHeaderCell scope="col">{t('usage.source')}</TableHeaderCell>
              <TableHeaderCell scope="col" className="num">
                {t('usage.total')}
              </TableHeaderCell>
              <TableHeaderCell scope="col" className="num">
                {t('usage.estimatedCost')}
              </TableHeaderCell>
              <TableHeaderCell scope="col" className="num">
                {t('usage.share')}
              </TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {sources.map((s) => (
              <TableRow key={s.source}>
                <TableHeaderCell scope="row">{name(s.source)}</TableHeaderCell>
                <TableCell className="num">{nb(f, tokensOf(s.usage))}</TableCell>
                <TableCell className="num">{money(f, t, costOf(s.usage))}</TableCell>
                <TableCell className="num">
                  {percentText(f, total > 0 ? tokensOf(s.usage) / total : 0)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Heading level={3} data-size="2xs" id="kilde-modell-h">
        {t('usage.modelsBySource')}
      </Heading>
      <div className="table-scroll" tabIndex={0} role="region" aria-labelledby="kilde-modell-h">
        <Table border className="usage-table">
          <TableHead>
            <TableRow>
              <TableHeaderCell scope="col">{t('usage.model')}</TableHeaderCell>
              <TableHeaderCell scope="col">{t('usage.source')}</TableHeaderCell>
              <TableHeaderCell scope="col" className="num">
                {t('usage.total')}
              </TableHeaderCell>
              <TableHeaderCell scope="col" className="num">
                {t('usage.estimatedCost')}
              </TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {report.byModel.map((m) => (
              <TableRow key={`${m.source ?? 'genki'}:${m.model}`}>
                <TableHeaderCell scope="row">{m.model}</TableHeaderCell>
                <TableCell>
                  <Tag data-size="sm" data-color={m.source === 'gateway' ? 'info' : 'neutral'}>
                    {name(m.source)}
                  </Tag>
                </TableCell>
                <TableCell className="num">{nb(f, tokensOf(m.usage))}</TableCell>
                <TableCell className="num">{money(f, t, costOf(m.usage))}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="meta">{t('usage.sourceNote')}</p>
    </section>
  );
};
