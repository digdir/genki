import {
  Button,
  Field,
  Heading,
  Input,
  Label,
  Paragraph,
  Select,
  Switch,
  Tag,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useId, useState } from 'react';
import type { ApiClient } from '../../api';
import {
  blockPath,
  changeOf,
  type CatalogItem,
  type SettingProperty,
  type SettingValue,
} from '../../api/building-blocks';
import { reasonPlaceholder } from '../../components/ApiCall';
import { ReasonField, reasonProblem } from '../../components/ReasonField';
import { useT, type Format, type T } from '../../i18n';
import { ApiCallButton, rightLabelFor, type Flash } from './common';

const decimal = (f: Format, n: number) =>
  f.number(n, { useGrouping: false, maximumFractionDigits: 10 });

export const formatSetting = (t: T, f: Format, p: SettingProperty, value: SettingValue) => {
  if (p.type === 'boolean') return value ? t('blocks.settingOn') : t('blocks.settingOff');
  if (p.type === 'string') {
    const i = p.enum?.indexOf(String(value)) ?? -1;
    return i >= 0 ? (p.enumTitles?.[i] ?? String(value)) : String(value);
  }
  if (p.type === 'number') return decimal(f, Number(value));
  return `${f.number(Number(value))}${p['x-unit'] ? ` ${p['x-unit']}` : ''}`;
};

const parseNumber = (raw: string) => Number(raw.trim().replace(/\s/g, '').replace(',', '.'));

const numberProblem = (t: T, f: Format, p: SettingProperty, raw: string) => {
  const n = parseNumber(raw);
  const outside =
    raw.trim() === '' ||
    Number.isNaN(n) ||
    (p.minimum !== undefined && n < p.minimum) ||
    (p.maximum !== undefined && n > p.maximum) ||
    (p.type === 'integer' && !Number.isInteger(n));
  if (!outside) return undefined;
  return t(p.type === 'integer' ? 'blocks.integerBetween' : 'blocks.numberBetween', {
    min: decimal(f, p.minimum ?? 0),
    max: decimal(f, p.maximum ?? 0),
  });
};

const adopted = (item: CatalogItem) =>
  item.status === 'in_use' || item.status === 'pending_approval';

export const SettingsForm = ({
  api,
  tenant,
  tenantName,
  item,
  canChange: hasRight,
  onSaved,
}: {
  api: ApiClient;
  tenant: string;
  tenantName: string;
  item: CatalogItem;
  canChange: boolean;
  onSaved: (flash: Flash) => void;
}) => {
  const t = useT();
  const fmt = useFormat();
  const headingId = useId();
  const canChange = hasRight && adopted(item);
  const base = useId();
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [problem, setProblem] = useState('');

  const fields = Object.entries(item.settingsSchema.properties).map(([key, p]) => {
    const current = item.tenantOverrides[key] ?? p.default;
    const numeric = p.type === 'integer' || p.type === 'number';
    const raw = draft[key] ?? (numeric ? decimal(fmt, Number(current)) : current);
    const error = numeric ? numberProblem(t, fmt, p, String(raw)) : undefined;
    const parsed: SettingValue =
      numeric && !error ? parseNumber(String(raw)) : (raw as SettingValue);
    const changed = !error && parsed !== current;
    return {
      key,
      p,
      current,
      raw,
      error,
      parsed,
      changed,
      overridden: key in item.tenantOverrides && item.tenantOverrides[key] !== p.default,
    };
  });
  const changes = fields.filter((f) => f.changed);
  const invalid = fields.filter((f) => f.error);
  const dirty = canChange && (changes.length > 0 || invalid.length > 0);
  const affected = item.usedBy.map((s) => s.name);
  const payload = Object.fromEntries(
    changes.map((f) => [f.key, f.parsed === f.p.default ? null : f.parsed]),
  );

  const update = (key: string, value: string | boolean) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setProblem('');
  };

  const reset = () => {
    setDraft({});
    setReason('');
    setTried(false);
    setProblem('');
  };

  const save = async () => {
    setTried(true);
    if (invalid.length > 0) {
      setProblem(t('blocks.fixInvalid'));
      return;
    }
    if (reasonProblem(reason, t)) return;
    const result = await api.buildingBlocks.saveSettings(tenant, item, payload, reason);
    reset();
    const text = t('blocks.settingsSaved', { name: item.name, tenant: tenantName });
    const change = changeOf(result);
    onSaved(change ? { kind: 'logged', text, change } : { kind: 'plain', text });
  };

  return (
    <section aria-labelledby={headingId} className="bb-settings">
      <div className="bb-stack-xs">
        <Heading level={2} data-size="xs" id={headingId}>
          {t('blocks.settingsTitle', { tenant: tenantName })}
        </Heading>
        <span className="bb-meta">
          {t('blocks.settingsIntro', {
            tenant: tenantName,
            name: item.name,
            right: rightLabelFor(t, item.kind),
          })}
        </span>
        {hasRight && !adopted(item) ? (
          <Paragraph data-size="sm">
            {t('blocks.settingsAdoptFirst', { tenant: tenantName })}
          </Paragraph>
        ) : null}
      </div>
      {fields.map((f) => {
        const id = `${base}-${f.key}`;
        const tag = f.changed
          ? { label: t('blocks.settingChanged'), color: 'warning' as const }
          : f.overridden
            ? {
                label: t('blocks.settingOverridden', { tenant: tenantName }),
                color: 'info' as const,
              }
            : { label: t('blocks.settingInherited'), color: 'neutral' as const };
        return (
          <div key={f.key} className="bb-setting">
            {f.p.type === 'boolean' ? (
              <Switch
                label={f.p.title}
                checked={Boolean(f.raw)}
                disabled={!canChange}
                onChange={(e) => update(f.key, e.target.checked)}
              />
            ) : (
              <Field>
                <Label htmlFor={id}>
                  {f.p.title}
                  {f.p['x-unit'] ? ` (${f.p['x-unit']})` : ''}
                </Label>
                {f.p.enum ? (
                  <Select
                    id={id}
                    value={String(f.raw)}
                    disabled={!canChange}
                    onChange={(e) => update(f.key, e.target.value)}
                  >
                    {f.p.enum.map((v, i) => (
                      <Select.Option key={v} value={v}>
                        {f.p.enumTitles?.[i] ?? v}
                      </Select.Option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    id={id}
                    type="text"
                    inputMode="decimal"
                    className="bb-number"
                    value={String(f.raw)}
                    disabled={!canChange}
                    aria-invalid={f.error ? true : undefined}
                    onChange={(e) => update(f.key, e.target.value)}
                  />
                )}
                {f.error ? <ValidationMessage>{f.error}</ValidationMessage> : null}
              </Field>
            )}
            {f.p.description ? <span className="bb-help">{f.p.description}</span> : null}
            <span className="bb-origin">
              <Tag data-size="sm" data-color={tag.color}>
                {tag.label}
              </Tag>
              {f.overridden || f.changed ? (
                <span className="bb-meta">
                  {t('blocks.platformDefault', {
                    value: formatSetting(t, fmt, f.p, f.p.default),
                  })}
                </span>
              ) : null}
            </span>
          </div>
        );
      })}
      {dirty ? (
        <div className="bb-changes">
          <div className="bb-stack-xs">
            <span className="bb-strong">{t('blocks.changes')}</span>
            <ul>
              {changes.map((f) => (
                <li key={f.key}>
                  {f.p.title}: {formatSetting(t, fmt, f.p, f.current)} →{' '}
                  {formatSetting(t, fmt, f.p, f.parsed)}
                </li>
              ))}
              {invalid.map((f) => (
                <li key={f.key}>{t('blocks.invalidValue', { title: f.p.title })}</li>
              ))}
            </ul>
            <span className="bb-meta">
              {affected.length > 0
                ? t('blocks.affects', { count: affected.length, names: fmt.list(affected) })
                : t('blocks.affectsNone')}
            </span>
          </div>
          <div className="bb-reason">
            <ReasonField value={reason} onChange={setReason} showError={tried} />
          </div>
          {problem ? (
            <Paragraph data-size="sm" role="alert" className="bb-error">
              {problem}
            </Paragraph>
          ) : null}
          <div className="actions">
            <Button variant="primary" onClick={() => void save()}>
              {t('blocks.saveSettings')}
            </Button>
            <Button variant="secondary" onClick={reset}>
              {t('blocks.discard')}
            </Button>
            <ApiCallButton
              call={() => ({
                action: t('blocks.saveSettings'),
                method: 'PUT',
                path: api.buildingBlocks.path(tenant, blockPath(item, '/settings')),
                body: { settings: payload, reason: reason.trim() || reasonPlaceholder },
                right: rightLabelFor(t, item.kind),
              })}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
};
