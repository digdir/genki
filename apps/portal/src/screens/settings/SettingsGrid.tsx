import {
  Chip,
  Fieldset,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import { NotDecided } from '../../components/NotDecided';
import type { SettingRow } from '../../data/settings';
import { useT, type Format, type T } from '../../i18n';
import {
  applies,
  effectiveOf,
  formatValue,
  isOverridden,
  isSet,
  layerName,
  layersFor,
  layerValue,
  sensColor,
  sensText,
  visibleIn,
  type Ctx,
  type Layer,
} from './model';
import { categoryText, settingDesc, settingLabel } from './text';

interface Cell {
  text: string;
  className: string;
  note?: string;
  effective?: boolean;
}

const cellsFor = (s: SettingRow, ctx: Ctx, t: T, f: Format): Cell[] => {
  const layers = layersFor(ctx.kind);
  const e = effectiveOf(s, ctx, t);
  let inherited = '–';
  return layers.map((l, i) => {
    if (i === layers.length - 1 && e.L === 'pin')
      return {
        text: formatValue(s, e.v, t, f),
        className: 'cell pinned',
        note: t('settings.gridPinnedTo', { version: e.pinVersion ?? '' }),
        effective: true,
      };
    if (!applies(s, l)) return { text: t('settings.gridCannotSet'), className: 'cell na' };
    const v = layerValue(s, l, ctx.target);
    if (!isSet(v))
      return { text: inherited, className: 'cell inherited', note: t('settings.gridInherited') };
    inherited = formatValue(s, v, t, f);
    const isEff = e.L === l;
    return {
      text: inherited,
      className: isEff ? 'cell set effective' : 'cell set',
      ...(s.type === 'secret' && v === 'set' ? { note: t('settings.gridReplaceInPanel') } : {}),
      effective: isEff,
    };
  });
};

const columnHeads = (ctx: Ctx, t: T): { label: string; sub: string }[] =>
  layersFor(ctx.kind).map((l: Layer) => ({
    label: l === 'P' || l === 'V' ? layerName(t, l) : ctx.target,
    sub: l === 'P' ? t('settings.digdir') : l === 'V' ? ctx.tenantName : layerName(t, l),
  }));

export const SettingsGrid = ({
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
  const [category, setCategory] = useState('alle');
  const [onlyOverridden, setOnlyOverridden] = useState(false);
  const rowsAll = all.filter((s) => visibleIn(s, ctx.kind));
  const q = query.trim().toLowerCase();
  const rows = rowsAll.filter(
    (s) =>
      (category === 'alle' || s.cat === category) &&
      (!q ||
        `${settingLabel(t, s)} ${s.id} ${s.apiKey ?? ''} ${settingDesc(t, s)}`
          .toLowerCase()
          .includes(q)) &&
      (!onlyOverridden || isOverridden(s, ctx)),
  );
  const heads = columnHeads(ctx, t);
  const groups = categories
    .map((cat) => ({ cat, rows: rows.filter((s) => s.cat === cat) }))
    .filter((g) => g.rows.length > 0);

  return (
    <div className="settings-grid stack-sm">
      <div className="settings-filters">
        <Textfield
          className="settings-search"
          label={t('settings.gridSearch')}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Fieldset>
          <Fieldset.Legend>{t('settings.gridCategory')}</Fieldset.Legend>
          <div className="tag-row">
            {['alle', ...categories].map((c) => (
              <Chip.Radio
                key={c}
                name="settings-category"
                checked={category === c}
                onChange={() => setCategory(c)}
              >
                {c === 'alle' ? t('settings.gridAll') : categoryText(t, c)}
              </Chip.Radio>
            ))}
          </div>
        </Fieldset>
        <Switch
          label={t('settings.gridOnlyOverridden')}
          checked={onlyOverridden}
          onChange={() => setOnlyOverridden((v) => !v)}
        />
      </div>
      <div className="settings-legend">
        <span aria-live="polite" className="meta">
          {t('settings.gridShowing', { shown: rows.length, total: rowsAll.length })}
        </span>
        <span className="legend-item">
          <span aria-hidden="true" className="legend-swatch" />
          {t('settings.gridEffective')}
        </span>
        <span className="legend-item meta">
          {t.rich('settings.gridInheritedLegend', { em: (c) => <em>{c}</em> })}
        </span>
      </div>
      <div
        className="table-scroll"
        tabIndex={0}
        role="region"
        aria-label={t('settings.gridRegion')}
      >
        <Table data-size="sm" className="settings-table">
          <TableHead>
            <TableRow>
              <TableHeaderCell scope="col" className="sticky-col">
                {t('settings.gridSetting')}
              </TableHeaderCell>
              {heads.map((h) => (
                <TableHeaderCell scope="col" key={h.label + h.sub} className="layer-col">
                  <span className="col-head">
                    <span>{h.label}</span>
                    <span className="col-sub">{h.sub}</span>
                  </span>
                </TableHeaderCell>
              ))}
              <TableHeaderCell scope="col" className="eff-col">
                {t('settings.gridApplies')}
              </TableHeaderCell>
            </TableRow>
          </TableHead>
          {groups.map((g) => (
            <TableBody key={g.cat}>
              <TableRow>
                <TableHeaderCell scope="rowgroup" colSpan={heads.length + 2} className="group-head">
                  {categoryText(t, g.cat)} <span className="group-count">({g.rows.length})</span>
                </TableHeaderCell>
              </TableRow>
              {g.rows.map((s) => {
                const e = effectiveOf(s, ctx, t);
                const active = selected === s.id;
                return (
                  <TableRow key={s.id} className={active ? 'row-active' : undefined}>
                    <TableHeaderCell scope="row" className="sticky-col row-head">
                      <span className="row-head-inner">
                        <button type="button" className="setting-open" onClick={() => onOpen(s.id)}>
                          {settingLabel(t, s)}
                        </button>
                        <span className="setting-key">{s.apiKey ?? s.id}</span>
                        <span className="tag-row">
                          {s.sens !== 'Lav' ? (
                            <Tag data-size="sm" data-color={sensColor[s.sens]}>
                              {sensText(t, s.sens)}
                            </Tag>
                          ) : null}
                          {s.notDecided ? <NotDecided /> : null}
                        </span>
                      </span>
                    </TableHeaderCell>
                    {cellsFor(s, ctx, t, f).map((c, i) => (
                      <TableCell key={i} className="cell-wrap">
                        <span className={c.className}>
                          <span className="cell-value">{c.text}</span>
                          {c.note ? <span className="cell-note">{c.note}</span> : null}
                          {c.effective ? (
                            <span className="visually-hidden">
                              {t('settings.gridAppliesHidden')}
                            </span>
                          ) : null}
                        </span>
                      </TableCell>
                    ))}
                    <TableCell>
                      <span className="eff">
                        <strong>{formatValue(s, e.v, t, f)}</strong>
                        <Tag data-size="sm" data-color={e.color}>
                          {e.src}
                        </Tag>
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          ))}
        </Table>
      </div>
      {rows.length === 0 ? (
        <p className="no-rows">
          {t('settings.gridNoMatch')}{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setQuery('');
              setCategory('alle');
              setOnlyOverridden(false);
            }}
          >
            {t('settings.gridReset')}
          </button>
        </p>
      ) : null}
      <p className="meta settings-foot">{t('settings.gridFoot')}</p>
    </div>
  );
};
