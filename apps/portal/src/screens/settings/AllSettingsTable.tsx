import {
  Button,
  Checkbox,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Textfield,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import type { SettingRow } from '../../data/settings';
import { useT, type T } from '../../i18n';
import { effectiveOf, formatValue, visibleIn, type Ctx } from './model';
import { settingDesc, settingLabel } from './text';

export const sourceOf = (s: SettingRow, ctx: Ctx, t: T) => {
  const e = effectiveOf(s, ctx, t);
  if (e.L === 'V') return { text: ctx.tenantName, changed: true };
  if (s.setByDigdir) return { text: t('settings.allSourceDigdir'), changed: true };
  return { text: t('settings.allSourceStandard'), changed: false };
};

export const AllSettingsTable = ({
  rows: all,
  categories,
  ctx,
  selected,
  onOpen,
}: {
  rows: SettingRow[];
  categories: string[];
  ctx: Ctx;
  selected: string | undefined;
  onOpen: (id: string) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const [query, setQuery] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const order = (s: SettingRow) => {
    const i = categories.indexOf(s.cat);
    return i < 0 ? categories.length : i;
  };
  const rowsAll = all.filter((s) => visibleIn(s, ctx.kind)).sort((a, b) => order(a) - order(b));
  const q = query.trim().toLowerCase();
  const rows = rowsAll.filter(
    (s) =>
      (!q ||
        `${settingLabel(t, s)} ${s.id} ${s.apiKey ?? ''} ${settingDesc(t, s)}`
          .toLowerCase()
          .includes(q)) &&
      (!onlyChanged || sourceOf(s, ctx, t).changed),
  );

  return (
    <div className="all-settings stack-sm">
      <div className="all-settings-filters">
        <Textfield
          className="settings-search"
          label={t('settings.allSearch')}
          placeholder={t('settings.allSearchPlaceholder')}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Checkbox
          label={t('settings.allOnlyChanged')}
          checked={onlyChanged}
          onChange={(e) => setOnlyChanged(e.target.checked)}
        />
      </div>
      <p role="status" className="meta">
        {t('settings.gridShowing', { shown: rows.length, total: rowsAll.length })}
      </p>
      {rows.length === 0 ? (
        <div className="no-rows stack-xs">
          <p>{t('settings.allNoMatch')}</p>
          <Button
            variant="secondary"
            data-size="sm"
            onClick={() => {
              setQuery('');
              setOnlyChanged(false);
            }}
          >
            {t('settings.allReset')}
          </Button>
        </div>
      ) : (
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label={t('settings.allRegion')}
        >
          <Table data-size="sm" className="all-settings-table">
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">{t('settings.gridSetting')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('settings.allValue')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('settings.allSource')}</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((s) => {
                const active = selected === s.id;
                return (
                  <TableRow key={s.id} className={active ? 'row-active' : undefined}>
                    <TableCell>
                      <button
                        type="button"
                        className="setting-open"
                        aria-expanded={active}
                        onClick={() => onOpen(s.id)}
                      >
                        {settingLabel(t, s)}
                      </button>
                      <br />
                      <code className="setting-key">{s.apiKey ?? s.id}</code>
                    </TableCell>
                    <TableCell>{formatValue(s, effectiveOf(s, ctx, t).v, t, f)}</TableCell>
                    <TableCell>{sourceOf(s, ctx, t).text}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
};
