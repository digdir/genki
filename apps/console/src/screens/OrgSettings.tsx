import {
  Button,
  Heading,
  Label,
  Paragraph,
  Select,
  Switch,
  Textfield,
} from '@digdir/designsystemet-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiClient } from '../api';
import { useAsync } from '../hooks';
import { useT, type T } from '../i18n';
import { settingLabels } from '../setting-labels';
import { shapeFromSchema } from '../settings-model';
import { ErrorState, Loading } from '../states';
import { SupportDialog } from '../support-dialog';
import type { EffectiveSettings, SettingInfo } from '../types';

interface Org {
  tenant: string;
  name: string;
}

export interface Change {
  key: string;
  label: string;
  from: string;
  to: string;
  value: unknown;
}

type Field = {
  key: string;
  label: string;
  category: string;
  description?: string;
  locked?: string;
} & (
  | { type: 'int' | 'float'; min?: number; max?: number }
  | { type: 'bool' }
  | { type: 'text' }
  | { type: 'enum'; options: { value: string; label: string }[] }
);

const show = (value: unknown, t: T) =>
  value === true
    ? t('supportAccess.yes')
    : value === false
      ? t('supportAccess.no')
      : value == null
        ? t('supportAccess.notSet')
        : String(value);

const fieldOf = (
  info: SettingInfo,
  current: unknown,
  locked: string | undefined,
  t: T,
): Field | undefined => {
  const named = settingLabels[info.key];
  const base = {
    key: info.key,
    label: named ? t(named.label) : info.key,
    category: named ? t(named.cat) : info.category,
    description: named?.desc ? t(named.desc) : info.description,
    ...(locked === undefined ? {} : { locked }),
  };
  const shape = shapeFromSchema(info.schema, t);
  if (shape?.type === 'enum') return { ...base, type: 'enum', options: shape.options ?? [] };
  if (shape?.type === 'int' || shape?.type === 'float')
    return {
      ...base,
      type: shape.type,
      ...(shape.min === undefined ? {} : { min: shape.min }),
      ...(shape.max === undefined ? {} : { max: shape.max }),
    };
  if (shape?.type === 'bool') return { ...base, type: 'bool' };
  if (shape?.type === 'text') return { ...base, type: 'text' };
  if (shape) return undefined;
  if (typeof current === 'number')
    return { ...base, type: Number.isInteger(current) ? 'int' : 'float' };
  if (typeof current === 'boolean') return { ...base, type: 'bool' };
  if (typeof current === 'string') return { ...base, type: 'text' };
  return undefined;
};

const parse = (field: Field, raw: string): unknown =>
  field.type === 'int' || field.type === 'float' ? Number(raw.replace(',', '.')) : raw;

const Frame = ({
  path,
  tenant,
  children,
}: {
  path: string;
  tenant: string;
  children: ReactNode;
}) => {
  const t = useT();
  return (
    <div className="support-frame">
      <div className="support-bar">
        <strong>{path}</strong>
        <span>{t('supportAccess.frameNote', { tenant })}</span>
      </div>
      <div className="support-body stack" role="region" aria-label={path}>
        {children}
      </div>
    </div>
  );
};

const matches = (f: Field, needle: string) =>
  !needle || [f.key, f.label, f.description ?? ''].some((x) => x.toLowerCase().includes(needle));

export const SettingsTab = ({
  api,
  org,
  focus,
  onSaved,
}: {
  api: ApiClient;
  org: Org;
  focus?: string | undefined;
  onSaved: (text: string) => void;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [state, retry] = useAsync(
    async (signal) => {
      const [catalog, effective] = await Promise.all([
        api.settingsCatalog(signal),
        api.tenantSettings(org.tenant, signal),
      ]);
      return { catalog, effective };
    },
    [api, org.tenant],
  );
  const [stored, setSaved] = useState<EffectiveSettings | undefined>();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [query, setQuery] = useState('');
  const focused = useRef(false);
  const saved = stored ?? (state.status === 'ready' ? state.data.effective : undefined);

  const fields =
    state.status === 'ready' && saved
      ? state.data.catalog
          .filter((s) => s.sensitivity === 'normal' && s.settableAt.includes('tenant'))
          .flatMap((s) => {
            const f = fieldOf(s, saved[s.key]?.value ?? s.default, saved[s.key]?.locked, t);
            return f ? [f] : [];
          })
      : [];
  const valueOf = (key: string) => saved?.[key]?.value;
  const changes: Change[] = fields.flatMap((f) => {
    if (f.locked !== undefined || !(f.key in draft)) return [];
    const value = parse(f, draft[f.key] ?? '');
    if (show(value, t) === show(valueOf(f.key), t)) return [];
    return [
      { key: f.key, label: f.label, from: show(valueOf(f.key), t), to: show(value, t), value },
    ];
  });
  const ready = state.status === 'ready';
  useEffect(() => {
    if (!ready || !focus || focused.current) return;
    const target = document.getElementById(`setting-${focus}`);
    if (!target) return;
    focused.current = true;
    target.scrollIntoView?.({ block: 'center' });
    target.querySelector<HTMLElement>('input, select, textarea')?.focus();
  }, [ready, focus]);

  if (state.status === 'loading') return <Loading label={t('supportAccess.loadingSettings')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  const renderField = (f: Field) => {
    const current = f.key in draft ? (draft[f.key] ?? '') : show(valueOf(f.key), t);
    const set = (v: string) => setDraft((d) => ({ ...d, [f.key]: v }));
    if (f.locked !== undefined)
      return (
        <Textfield
          className="narrow"
          label={f.label}
          description={t('supportAccess.lockedBy', { reason: f.locked })}
          value={show(valueOf(f.key), t)}
          readOnly
        />
      );
    if (f.type === 'bool')
      return (
        <Switch
          label={f.label}
          description={f.description}
          checked={(f.key in draft ? draft[f.key] : String(valueOf(f.key))) === 'true'}
          onChange={(e) => set(String(e.target.checked))}
        />
      );
    if (f.type === 'enum')
      return (
        <div className="field narrow">
          <Label htmlFor={`s-${f.key}`}>{f.label}</Label>
          <Select
            id={`s-${f.key}`}
            value={f.key in draft ? draft[f.key] : String(valueOf(f.key) ?? '')}
            onChange={(e) => set(e.target.value)}
          >
            {f.options.map((o) => (
              <Select.Option key={o.value} value={o.value}>
                {o.label}
              </Select.Option>
            ))}
          </Select>
        </div>
      );
    return (
      <Textfield
        className="narrow"
        label={f.label}
        description={f.description}
        inputMode={f.type === 'text' ? undefined : 'decimal'}
        value={current === t('supportAccess.notSet') ? '' : current}
        onChange={(e) => set(e.target.value)}
      />
    );
  };
  const first = changes[0];
  const needle = query.trim().toLowerCase();
  const shown = fields.filter((f) => matches(f, needle));
  const groups = [...new Set(shown.map((f) => f.category))].map((category) => ({
    category,
    items: shown.filter((f) => f.category === category),
  }));
  return (
    <Frame path={t('supportAccess.settingsPath')} tenant={org.name}>
      <Paragraph data-size="sm" className="meta">
        {t('supportAccess.tenantLevel', { tenant: org.name })}
      </Paragraph>
      {fields.length === 0 ? (
        <Paragraph>{t('supportAccess.noneSettable')}</Paragraph>
      ) : (
        <Textfield
          className="search-field"
          label={t('supportAccess.searchSettings')}
          description={t('supportAccess.searchSettingsHelp')}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {fields.length > 0 && shown.length === 0 ? (
        <Paragraph>{t('supportAccess.noSettingMatch')}</Paragraph>
      ) : null}
      {groups.map(({ category, items }, i) => (
        <section key={category} className="stack-sm" aria-labelledby={`setting-group-${i}`}>
          <Heading level={3} data-size="2xs" id={`setting-group-${i}`}>
            {category}
          </Heading>
          {items.map((f) => (
            <div key={f.key} id={`setting-${f.key}`}>
              {renderField(f)}
            </div>
          ))}
        </section>
      ))}
      <div className="actions-row">
        <Button
          aria-disabled={changes.length === 0 || undefined}
          onClick={() => changes.length && setConfirming(true)}
        >
          {t('supportAccess.save')}
        </Button>
        <span className="meta">
          {changes.length
            ? t('supportAccess.unsaved', { count: changes.length })
            : t('supportAccess.noChanges')}
        </span>
      </div>
      <SupportDialog
        open={confirming}
        title={t('supportAccess.changeTitle', { tenant: org.name })}
        hint={t('supportAccess.reasonHint')}
        sees={t('supportAccess.seesChange', { tenant: org.name })}
        cta={t('supportAccess.saveAsDigdir')}
        api={{
          method: 'PUT',
          path: `/tenants/${org.tenant}/settings/${first?.key ?? '{key}'}`,
          body: () => ({ value: first?.value }),
        }}
        onClose={() => setConfirming(false)}
        onConfirm={async (reason) => {
          for (const c of changes) await api.setTenantSetting(org.tenant, c.key, c.value, reason);
          setSaved(
            Object.fromEntries(
              Object.entries(saved ?? {}).map(([k, v]) => {
                const c = changes.find((x) => x.key === k);
                return [k, c ? { ...v, value: c.value } : v];
              }),
            ),
          );
          setDraft({});
          onSaved(tRef.current('supportAccess.savedAsDigdir', { tenant: org.name }));
        }}
      >
        <ChangeList changes={changes} />
        <Paragraph data-size="sm">{t('supportAccess.affectsAll', { tenant: org.name })}</Paragraph>
      </SupportDialog>
    </Frame>
  );
};

export const ChangeList = ({ changes }: { changes: Change[] }) => (
  <ul className="plain change-list">
    {changes.map((c) => (
      <li key={c.key}>
        <span className="label-strong">{c.label}:</span>
        <span>
          <del>{c.from}</del> → <ins>{c.to}</ins>
        </span>
      </li>
    ))}
  </ul>
);
