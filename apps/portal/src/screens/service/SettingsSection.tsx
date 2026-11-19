import { useState } from 'react';
import type { SettingRow } from '../../data/settings';
import { useT } from '../../i18n';
import type { ScreenProps } from '../../screen';
import { Settings } from '../Settings';
import { RowsArea } from '../services/setup-area-views';
import { settingLabels } from '../settings/labels';
import { settingLabel } from '../settings/text';

export interface LimitsSummary {
  logMasked: boolean;
  own: Record<string, unknown>;
  onLogging: () => void;
}

const shown = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : JSON.stringify(value);

export const SettingsSection = (
  props: ScreenProps & { id: string; limits?: LimitsSummary | undefined; readOnly?: boolean },
) => {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const settings = <Settings {...props} context={{ kind: 'service', id: props.id }} />;
  const { limits } = props;
  if (!limits) return settings;
  const open = () => setEditing(true);
  return (
    <RowsArea
      rows={[
        {
          key: 'logging',
          title: t('setupList.limitsLogging'),
          text: t(limits.logMasked ? 'setupList.limitsMasked' : 'setupList.limitsUnmasked'),
          action: { label: t('setupList.edit'), onClick: limits.onLogging },
        },
        ...Object.entries(limits.own).map(([key, value]) => {
          const title = settingLabel(t, {
            id: key,
            label: settingLabels[key]?.label ?? key,
          } as SettingRow);
          return {
            key,
            title,
            text: shown(value),
            action: {
              label: t('setupList.edit'),
              aria: t('setupList.editNamed', { name: title }),
              onClick: open,
            },
          };
        }),
      ]}
      addLabel={t('setupList.limitsEdit')}
      editor={settings}
      readOnly={props.readOnly ?? false}
      editing={editing}
      onEditing={setEditing}
    />
  );
};
