import { Tag } from '@digdir/designsystemet-react';
import type { CatalogItem } from '../../api/building-blocks';
import { useT } from '../../i18n';

export const UsageTag = ({ block }: { block: CatalogItem | undefined }) => {
  const t = useT();
  if (!block) return null;
  const count = block.usedBy.length;
  return (
    <Tag data-size="sm" data-color={count ? 'info' : 'neutral'}>
      {count ? t('sharedServices.usedIn', { count }) : t('sharedServices.notUsedYet')}
    </Tag>
  );
};
