import { Alert, Button, Dialog, Heading, Link, Paragraph } from '@digdir/designsystemet-react';
import { useState } from 'react';
import { BusyButton } from '../../components/BusyButton';
import { useT } from '../../i18n';
import { saverName, type Saver } from './DraftBar';
import './setup-layout.css';

export interface LostItem {
  label: string;
  text: string;
}

export const DiscardDialog = ({
  name,
  version,
  items,
  savedAt,
  savedBy,
  detailsHref,
  onKeep,
  onConfirm,
}: {
  name: string;
  version: number;
  items: LostItem[];
  savedAt?: string | undefined;
  savedBy?: Saver | undefined;
  detailsHref: string;
  onKeep: () => void;
  onConfirm: () => Promise<void>;
}) => {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const count = items.length;
  const confirm = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('serviceDraft.discardFailed'));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      modal
      role="alertdialog"
      closeButton={false}
      onClose={() => !busy && onKeep()}
      aria-labelledby="discard-h"
      aria-describedby="discard-d"
      className="discard-dialog"
    >
      <div className="stack">
        <Heading level={2} data-size="sm" id="discard-h">
          {count ? t('serviceDraft.discardTitle', { count }) : t('serviceDraft.discardTitleNone')}
        </Heading>
        <Paragraph id="discard-d">{t('serviceDraft.discardText', { name, n: version })}</Paragraph>
        {count ? (
          <div className="stack-xs">
            <strong className="discard-lost-title">{t('serviceDraft.discardLost')}</strong>
            <ul className="discard-lost">
              {items.map((item, i) => (
                <li key={`${item.label}-${i}`}>
                  <span className="meta">{item.label}</span>
                  <span>{item.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <Paragraph data-size="sm" className="meta">
          {savedAt
            ? `${
                savedBy && (savedBy.self || savedBy.name)
                  ? t('serviceDraft.discardSavedBy', { name: saverName(t, savedBy), when: savedAt })
                  : t('serviceDraft.discardSavedAt', { when: savedAt })
              } `
            : null}
          <Link href={detailsHref}>{t('serviceDraft.discardDetails')}</Link>
        </Paragraph>
        {error ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            {error}
          </Alert>
        ) : null}
        <div className="actions discard-actions">
          <Button
            variant="secondary"
            data-size="sm"
            onClick={() => !busy && onKeep()}
            aria-disabled={busy || undefined}
          >
            {t('serviceDraft.discardKeep')}
          </Button>
          <BusyButton
            variant="primary"
            data-color="danger"
            data-size="sm"
            busy={busy}
            busyLabel={t('serviceDraft.discarding')}
            onClick={() => void confirm()}
          >
            {count
              ? t('serviceDraft.discardConfirm', { count })
              : t('serviceDraft.discardConfirmNone')}
          </BusyButton>
        </div>
      </div>
    </Dialog>
  );
};
