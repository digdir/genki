import { Checkbox, Fieldset, Paragraph } from '@digdir/designsystemet-react';
import { useT, type T } from '../../i18n';
import type { SettingInfo } from '../../types';

export interface OverrideGroup {
  prefix: string;
  label: string;
  settings: { key: string; label: string }[];
}

export const overrideGroups = (catalog: SettingInfo[]): OverrideGroup[] => {
  const groups = new Map<string, OverrideGroup>();
  for (const s of catalog.filter((x) => x.settableAt.includes('call'))) {
    const prefix = s.key.includes('.') ? s.key.slice(0, s.key.indexOf('.')) : s.key;
    const group = groups.get(prefix) ?? { prefix, label: s.category, settings: [] };
    group.settings.push({ key: s.key, label: s.description });
    groups.set(prefix, group);
  }
  return [...groups.values()];
};

export const overrideLabel = (t: T, groups: OverrideGroup[], value: string) => {
  if (value.endsWith('.*')) {
    const group = groups.find((g) => `${g.prefix}.*` === value);
    return group ? t('serviceOverrides.allAbout', { name: group.label.toLowerCase() }) : value;
  }
  return groups.flatMap((g) => g.settings).find((s) => s.key === value)?.label ?? value;
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
