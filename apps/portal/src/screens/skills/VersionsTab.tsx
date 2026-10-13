import { Tag } from '@digdir/designsystemet-react';
import type { SkillVersion } from '../../api/skills';
import { useFormat } from '@genai/i18n/react';
import { changedWhen } from '../../components/ChangeLogged';
import { useT, type PlainKey } from '../../i18n';
import { scoreText } from '../../data/skills';

export interface DraftRow {
  version: number;
  changes: string[];
  score: string;
}

const stateOf = (v: SkillVersion, inUse: boolean): PlainKey =>
  !v.current
    ? 'skills.versionPrevious'
    : v.shared
      ? 'skills.versionSharedState'
      : inUse
        ? 'skills.versionInUse'
        : 'skills.versionPublished';

export const VersionsTab = ({
  draft,
  versions,
  inUse,
}: {
  draft: DraftRow | undefined;
  versions: SkillVersion[];
  inUse: boolean;
}) => {
  const t = useT();
  const f = useFormat();
  return (
    <ol className="plain-list skill-versions" aria-label={t('skills.versionsLabel')}>
      {draft ? (
        <li>
          <span className="skill-version-label">
            {t('skills.versionDraftOf', { version: draft.version })}
          </span>
          <Tag data-size="sm" data-color="neutral">
            {t('skills.versionDraftTag')}
          </Tag>
          <span className="skill-version-meta">{draft.changes.join(' · ')}</span>
          <span>{draft.score}</span>
        </li>
      ) : null}
      {versions.map((v) => {
        const state = t(stateOf(v, inUse));
        return (
          <li key={v.version}>
            <span className="skill-version-label">
              {t('skills.versionN', { version: v.version })}
            </span>
            <Tag data-size="sm" data-color={v.current ? 'success' : 'neutral'}>
              {state}
            </Tag>
            <span className="skill-version-meta">
              {changedWhen(new Date(v.publishedAt), undefined, f, t)} · {v.by}
            </span>
            <span>
              {v.score
                ? scoreText(t, v.score.passed, v.score.total)
                : v.testedBy
                  ? t('skills.versionTestedBy', { name: v.testedBy })
                  : t('skills.versionNoTests')}
            </span>
          </li>
        );
      })}
      {!draft && versions.length === 0 ? <li>{t('skills.versionsNone')}</li> : null}
    </ol>
  );
};
