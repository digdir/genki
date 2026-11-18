import { useFormat } from '@genai/i18n/react';
import type { SkillUse, SkillVersion } from '../../api/skills';
import { changedWhen } from '../../components/ChangeLogged';
import { useT } from '../../i18n';

export const VersionsTab = ({
  versions,
  services,
}: {
  versions: SkillVersion[];
  services: SkillUse[];
}) => {
  const t = useT();
  const f = useFormat();
  const inUse = new Set(services.map((s) => s.version));
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  if (sorted.length === 0) return <p className="skill-help">{t('skills.versionsNone')}</p>;
  return (
    <ul className="plain-list skill-versions" aria-label={t('skills.versionsLabel')}>
      {sorted.map((v) => {
        const line = {
          version: v.version,
          when: changedWhen(new Date(v.publishedAt), undefined, f, t),
          by: v.by,
        };
        return (
          <li key={v.version}>
            <span className="skill-version-title">
              {inUse.has(v.version)
                ? t('skills.versionLineInUse', line)
                : t('skills.versionLine', line)}
            </span>
            <span className="skill-help">
              {v.reason
                ? t('skills.versionReason', { reason: v.reason })
                : t('skills.versionNoReason')}
            </span>
          </li>
        );
      })}
    </ul>
  );
};
