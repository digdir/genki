import { Tag } from '@digdir/designsystemet-react';
import { useT, type PlainKey } from '../i18n';
import type { Residency } from '../types';

const locationKeys: Record<Residency, PlainKey> = {
  norway: 'components.locationNorway',
  eu: 'components.locationEu',
  global: 'components.locationGlobal',
};

export const DataLocationTag = ({ location }: { location: Residency }) => {
  const t = useT();
  return (
    <Tag data-color={location === 'global' ? 'warning' : 'neutral'} data-size="sm">
      {t(locationKeys[location])}
    </Tag>
  );
};
