import { Tag } from '@digdir/designsystemet-react';
import { useT } from '../../i18n';
import type { RejectedEditorCard } from './model';

export const RejectedCard = ({ card }: { card: RejectedEditorCard }) => {
  const t = useT();
  return (
    <div className="change-card rejected">
      <Tag data-size="sm" data-color="danger" className="change-card-tag">
        {t('skills.rejectedTag')}
      </Tag>
      <dl className="kv">
        <dt>{t('skills.rejectedAttempted')}</dt>
        <dd>{card.attempted}</dd>
        <dt>{t('skills.rejectedWhy')}</dt>
        <dd>{card.reason}</dd>
        <dt>{t('skills.rejectedCode')}</dt>
        <dd>
          <code>{card.code}</code>
        </dd>
      </dl>
    </div>
  );
};
