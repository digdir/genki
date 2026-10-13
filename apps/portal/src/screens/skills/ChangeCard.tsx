import { Button, Tag } from '@digdir/designsystemet-react';
import { useState } from 'react';
import { useT } from '../../i18n';

export interface ChangeCardProps {
  title: string;
  detail: string;
  before?: string | undefined;
  after: string;
  afterLabel?: string | undefined;
  undone: boolean;
  canUndo: boolean;
  onUndo: () => void;
}

export const ChangeCard = ({
  title,
  detail,
  before,
  after,
  afterLabel,
  undone,
  canUndo,
  onUndo,
}: ChangeCardProps) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="change-card">
      <Tag data-size="sm" data-color={undone ? 'neutral' : 'accent'} className="change-card-tag">
        {undone ? t('skills.cardUndone') : t('skills.cardProposal')}
      </Tag>
      <span className={undone ? 'change-card-title undone' : 'change-card-title'}>{title}</span>
      <span className="change-card-detail">{detail}</span>
      {open ? (
        before !== undefined ? (
          <div className="change-card-diff">
            <div>
              <span className="change-card-label">{t('skills.cardBefore')}</span>
              <div className="change-card-before">{before}</div>
            </div>
            <div>
              <span className="change-card-label">{t('skills.cardAfter')}</span>
              <div className="change-card-after">{after}</div>
            </div>
          </div>
        ) : (
          <div>
            {afterLabel ? <span className="change-card-label">{afterLabel}</span> : null}
            <div className="change-card-after">{after}</div>
          </div>
        )
      ) : null}
      <div className="change-card-actions">
        <Button
          variant="tertiary"
          data-size="sm"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? t('skills.cardHide') : t('skills.cardShow')}
        </Button>
        {canUndo && !undone ? (
          <Button variant="tertiary" data-size="sm" onClick={onUndo}>
            {t('skills.cardUndo')}
          </Button>
        ) : null}
      </div>
    </div>
  );
};
