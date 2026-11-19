import { Checkbox, Fieldset, Paragraph } from '@digdir/designsystemet-react';
import { useT, type T } from '../../i18n';
import type { SettingInfo } from '../../types';

export interface OverrideGroup {
  prefix: string;
  label: string;
  settings: { key: string; label: string }[];
}

const prefixOf = (key: string) => (key.includes('.') ? key.slice(0, key.indexOf('.')) : key);

const defined = (t: T, key: string, fallback: string) => {
  const full = `settingDefs.${key.replace(/[^A-Za-z0-9]+/g, '_')}`;
  return t.has(full) ? t.template(full) : fallback;
};

const keyLabel = (t: T, key: string, fallback: string) => defined(t, `${key}_label`, fallback);

const groupLabel = (t: T, prefix: string, category: string) =>
  defined(t, `group_${prefix}`, category);

export const overrideGroups = (t: T, catalog: SettingInfo[]): OverrideGroup[] => {
  const groups = new Map<string, OverrideGroup>();
  for (const s of catalog.filter((x) => x.settableAt.includes('call'))) {
    const prefix = prefixOf(s.key);
    const group = groups.get(prefix) ?? {
      prefix,
      label: groupLabel(t, prefix, s.category),
      settings: [],
    };
    group.settings.push({ key: s.key, label: keyLabel(t, s.key, s.description) });
    groups.set(prefix, group);
  }
  return [...groups.values()];
};

export const overrideLabel = (t: T, groups: OverrideGroup[], value: string) => {
  if (value.endsWith('.*')) {
    const prefix = value.slice(0, -2);
    const name = groups.find((g) => g.prefix === prefix)?.label ?? groupLabel(t, prefix, prefix);
    return t('serviceOverrides.allAbout', { name: name.toLowerCase() });
  }
  return (
    groups.flatMap((g) => g.settings).find((s) => s.key === value)?.label ??
    keyLabel(t, value, value)
  );
};

export const OverridePicker = ({
  id,
  groups,
  value,
  onChange,
}: {
  id: string;
  groups: OverrideGroup[];
  value: string[];
  onChange: (next: string[]) => void;
}) => {
  const t = useT();
  const toggle = (v: string) =>
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <Fieldset id={id} data-size="sm">
      <Fieldset.Legend>{t('serviceOverrides.legend')}</Fieldset.Legend>
      <Fieldset.Description>{t('serviceOverrides.description')}</Fieldset.Description>
      {groups.length === 0 ? (
        <Paragraph data-size="sm" className="meta">
          {t('serviceOverrides.none')}
        </Paragraph>
      ) : (
        groups.map((g) => {
          const wildcard = `${g.prefix}.*`;
          const all = value.includes(wildcard);
          return (
            <div key={g.prefix} className="fe-override-group">
              <Checkbox
                label={t('serviceOverrides.allAbout', { name: g.label.toLowerCase() })}
                description={t('serviceOverrides.allDescription', { wildcard })}
                checked={all}
                onChange={() =>
                  onChange(
                    all
                      ? value.filter((x) => x !== wildcard)
                      : [...value.filter((x) => !g.settings.some((s) => s.key === x)), wildcard],
                  )
                }
              />
              {all
                ? null
                : g.settings.map((s) => (
                    <Checkbox
                      key={s.key}
                      className="fe-override-item"
                      label={s.label}
                      description={s.key}
                      checked={value.includes(s.key)}
                      onChange={() => toggle(s.key)}
                    />
                  ))}
            </div>
          );
        })
      )}
    </Fieldset>
  );
};
