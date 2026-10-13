import { Alert, Button, Paragraph, Tag } from '@digdir/designsystemet-react';
import { useState } from 'react';
import type { VersionRow } from '../../data/services';
import { useT, type PlainKey } from '../../i18n';

export interface VersionItem extends VersionRow {
  reason?: string;
  live?: boolean;
}

const stateKey = {
  'I test': 'versionsTab.stateTest',
  'I bruk': 'versionsTab.stateLive',
  Tidligere: 'versionsTab.stateFormer',
} as const satisfies Record<VersionRow['state'], PlainKey>;

const stateColor = { 'I test': 'info', 'I bruk': 'success', Tidligere: 'neutral' } as const;

interface Props {
  versions: VersionItem[];
  changes: string[];
  onRollback: (version: VersionItem) => Promise<void> | void;
}

export const VersionsTab = ({ versions, changes, onRollback }: Props) => {
  const t = useT();
  const [compare, setCompare] = useState<number>();
  const [confirm, setConfirm] = useState<number>();
  const draftLabel = changes.length
    ? t('versionsTab.draftChanges', {
        count: changes.length,
        version: versions[0] ? versions[0].n : '–',
      })
    : t('versionsTab.noChanges');
  return (
    <ol className="plain-list version-list" aria-label={t('versionsTab.label')}>
      <li className="version-draft">
        <span className="tag-row">
          <span className="version-name">{t('versionsTab.draft')}</span>
          <Tag data-size="sm" data-color="neutral">
            {t('versionsTab.unpublished')}
          </Tag>
        </span>
        <span className="meta">{draftLabel}</span>
      </li>
      {versions.map((v) => {
        const open = compare === v.n;
        const confirming = confirm === v.n;
        const diff = [...changes, ...v.diff];
        const diffId = `versjon-${v.n}-diff`;
        return (
          <li key={v.n}>
            <div className="tag-row">
              <span className="version-name">{t('versionsTab.version', { n: v.n })}</span>
              <Tag data-size="sm" data-color={stateColor[v.state]}>
                {t(stateKey[v.state])}
              </Tag>
              <span className="meta">
                {v.when} · {v.who}
              </span>
            </div>
            {v.score ? <span className="version-score">{v.score}</span> : null}
            {v.reason ? (
              <span className="meta">{t('versionsTab.reason', { reason: v.reason })}</span>
            ) : null}
            <div className="row-wrap">
              <Button
                variant="tertiary"
                data-size="sm"
                aria-expanded={open}
                aria-controls={open ? diffId : undefined}
                onClick={() => setCompare(open ? undefined : v.n)}
              >
                {t('versionsTab.compare')}
                <span className="visually-hidden">
                  {t('versionsTab.versionSuffix', { n: v.n })}
                </span>
              </Button>
              {confirming ? null : (
                <Button variant="secondary" data-size="sm" onClick={() => setConfirm(v.n)}>
                  {t('versionsTab.rollbackHere')}
                  <span className="visually-hidden">
                    {t('versionsTab.versionSuffix', { n: v.n })}
                  </span>
                </Button>
              )}
            </div>
            {open ? (
              <div id={diffId} className="version-diff">
                <span className="version-diff-title">{t('versionsTab.changedInDraft')}</span>
                <ul className="bullets">
                  {(diff.length ? diff : [t('versionsTab.noDifferences')]).map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {confirming ? (
              <Alert data-color="warning" data-size="sm">
                <Paragraph data-size="sm">{t('versionsTab.rollbackNote', { n: v.n })}</Paragraph>
                <div className="row-wrap">
                  <Button
                    variant="primary"
                    data-size="sm"
                    onClick={() => {
                      setConfirm(undefined);
                      void onRollback(v);
                    }}
                  >
                    {t('versionsTab.rollback')}
                  </Button>
                  <Button variant="secondary" data-size="sm" onClick={() => setConfirm(undefined)}>
                    {t('versionsTab.cancel')}
                  </Button>
                </div>
              </Alert>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
};
