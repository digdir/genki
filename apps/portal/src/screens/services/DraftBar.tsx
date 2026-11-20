import { Button, Link } from '@digdir/designsystemet-react';
import { useState, type ReactNode } from 'react';
import { useT, type T } from '../../i18n';
import './setup-layout.css';

export type SaveState = 'idle' | 'unsaved' | 'saving' | 'failed' | 'conflict';

export interface SavedBy {
  by: string;
  name: string | null;
}

export type Saver = { self: true } | { self: false; name: string | null };

export const savedByOf = (draft: { by?: string; byName?: string | null }): SavedBy | undefined =>
  draft.by ? { by: draft.by, name: draft.byName ?? null } : undefined;

export const saverOf = (
  saved: SavedBy | undefined,
  self: { actor?: string | undefined; name?: string | undefined },
): Saver | undefined =>
  !saved
    ? undefined
    : saved.by === self.actor || (!!saved.name && saved.name === self.name)
      ? { self: true }
      : { self: false, name: saved.name };

export const saverName = (t: T, saver: Saver) =>
  saver.self ? t('serviceDraft.you') : (saver.name ?? t('serviceDraft.unknownSaver'));

export interface DraftBarProps {
  state: SaveState;
  version: number;
  changes: number;
  hasDraft: boolean;
  savedAt?: string | undefined;
  savedBy?: Saver | undefined;
  failedAt?: string | undefined;
  conflictBy?: { saver: Saver | undefined; at: string } | undefined;
  conflictDiff?: ReactNode;
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
  savedBy,
  failedAt,
  conflictBy,
  conflictDiff,
  canEdit,
  changesHref,
  onSave,
  onDiscard,
}: DraftBarProps) => {
  const t = useT();
  const [diffOpen, setDiffOpen] = useState(false);
  const other = savedBy && !savedBy.self ? savedBy : undefined;
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
                text: conflictBy
                  ? t('serviceDraft.conflictBy', {
                      name: conflictBy.saver
                        ? saverName(t, conflictBy.saver)
                        : t('serviceDraft.unknownSaver'),
                      time: conflictBy.at,
                    })
                  : t('serviceDraft.conflictText'),
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
                  more: t('serviceDraft.inUseUntil', { n: version }),
                  by: other ? t('serviceDraft.savedBy', { name: saverName(t, other) }) : '',
                };
  const actions = canEdit && hasDraft && state !== 'conflict';
  return (
    <div role="region" aria-label={t('serviceDraft.region')} className={`draft-bar ${view.tone}`}>
      <span aria-hidden="true" className="draft-bar-dot" />
      <div className="draft-bar-text" aria-live="polite">
        <strong>{view.title}</strong>{' '}
        <span>
          {view.text}
          {'more' in view ? <span className="draft-bar-more"> {view.more}</span> : null}
          {'by' in view && view.by ? ` ${view.by}` : null}
        </span>
      </div>
      {state === 'failed' && canEdit ? (
        <Button variant="primary" data-size="sm" onClick={onSave}>
          {t('serviceDraft.save')}
        </Button>
      ) : null}
      {state === 'conflict' && conflictDiff ? (
        <Link asChild>
          <button
            type="button"
            className="link-button"
            aria-expanded={diffOpen}
            onClick={() => setDiffOpen((open) => !open)}
          >
            {t('serviceDraft.showDifference')}
          </button>
        </Link>
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
      {state === 'conflict' && diffOpen ? (
        <div className="draft-bar-diff">{conflictDiff}</div>
      ) : null}
    </div>
  );
};
