import { Button, Link } from '@digdir/designsystemet-react';
import { useT } from '../../i18n';
import './setup-layout.css';

export type SaveState = 'idle' | 'unsaved' | 'saving' | 'failed' | 'conflict';

export interface DraftBarProps {
  state: SaveState;
  version: number;
  changes: number;
  hasDraft: boolean;
  savedAt?: string | undefined;
  failedAt?: string | undefined;
  canEdit: boolean;
  changesHref: string;
  onSave: () => void;
  onDiscard: () => void;
}

export const DraftBar = ({
  state,
  version,
  changes,
  hasDraft,
  savedAt,
  failedAt,
  canEdit,
  changesHref,
  onSave,
  onDiscard,
}: DraftBarProps) => {
  const t = useT();
  const view =
    state === 'unsaved'
      ? { tone: 'unsaved', title: t('serviceDraft.unsaved'), text: t('serviceDraft.unsavedText') }
      : state === 'saving'
        ? { tone: 'draft', title: t('serviceDraft.saving'), text: t('serviceDraft.savingText') }
        : state === 'failed'
          ? {
              tone: 'failed',
              title: t('serviceDraft.failed'),
              text: t('serviceDraft.failedText', { time: failedAt ?? '' }),
            }
          : state === 'conflict'
            ? {
                tone: 'failed',
                title: t('serviceDraft.conflict'),
                text: t('serviceDraft.conflictText'),
              }
            : !hasDraft
              ? {
                  tone: 'clean',
                  title: t('serviceDraft.noChanges'),
                  text: t('serviceDraft.noChangesText', { n: version }),
                }
              : {
                  tone: 'draft',
                  title: savedAt
                    ? t('serviceDraft.savedAt', { time: savedAt })
                    : t('serviceDraft.saved'),
                  text: changes
                    ? t('serviceDraft.changesSince', { count: changes, n: version })
                    : t('serviceDraft.noChangesSince', { n: version }),
                };
  const actions = canEdit && hasDraft && state !== 'conflict';
  return (
    <div role="region" aria-label={t('serviceDraft.region')} className={`draft-bar ${view.tone}`}>
      <span aria-hidden="true" className="draft-bar-dot" />
      <div className="draft-bar-text" aria-live="polite">
        <strong>{view.title}</strong>
        <span>{view.text}</span>
      </div>
      {state === 'failed' && canEdit ? (
        <Button variant="primary" data-size="sm" onClick={onSave}>
          {t('serviceDraft.save')}
        </Button>
      ) : null}
      {actions ? (
        <span className="draft-bar-actions">
          <Link href={changesHref}>{t('serviceDraft.showChanges')}</Link>
          <Link asChild data-color="danger">
            <button type="button" className="link-button" onClick={onDiscard}>
              {t('serviceDraft.discard')}
            </button>
          </Link>
        </span>
      ) : null}
    </div>
  );
};
