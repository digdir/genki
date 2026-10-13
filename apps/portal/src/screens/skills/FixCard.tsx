import { Button, Heading, Paragraph } from '@digdir/designsystemet-react';
import type { SkillFix } from '../../api/skills';
import { useT } from '../../i18n';
import { DiffLines } from '../quality/DiffLines';

export const FixCard = ({
  fix,
  busy,
  onApply,
  onDiscard,
}: {
  fix: SkillFix;
  busy: boolean;
  onApply: () => void;
  onDiscard: () => void;
}) => {
  const t = useT();
  return (
    <section aria-labelledby="skill-fix-h" className="change-card">
      <Heading level={2} data-size="2xs" id="skill-fix-h">
        {t('skills.fixTitle')}
      </Heading>
      <Paragraph data-size="sm">{t('skills.fixNote')}</Paragraph>
      <DiffLines title={t('skills.fixDiffTitle')} before={fix.before} after={fix.after} />
      <div className="change-card-actions">
        <Button
          variant="primary"
          data-size="sm"
          aria-disabled={busy || undefined}
          onClick={() => !busy && onApply()}
        >
          {t('skills.fixApply')}
        </Button>
        <Button variant="secondary" data-size="sm" onClick={onDiscard}>
          {t('skills.discard')}
        </Button>
      </div>
    </section>
  );
};
