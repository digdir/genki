import { Heading, Link, Tag } from '@digdir/designsystemet-react';
import { LanguageChoice } from '@genai/i18n/react';
import { useT } from '../i18n';
import { useRightLabels, useUserName } from '../Shell';

export const Profile = () => {
  const t = useT();
  const name = useUserName();
  const labels = useRightLabels();
  return (
    <>
      <Heading level={1} data-size="lg">
        {t('shell.menuProfile')}
      </Heading>
      <p className="lead">{name}</p>
      <section className="user-rights">
        <Heading level={2} data-size="xs">
          {t('shell.yourRights')}
        </Heading>
        <div className="tag-row">
          {labels.map((r) => (
            <Tag key={r} data-color="neutral" data-size="sm">
              {r}
            </Tag>
          ))}
        </div>
        <span className="small">{t('shell.rightsGivenBy')}</span>
        <Link href="https://www.altinn.no" target="_blank" rel="noopener">
          {t('shell.seeInAltinn')}
        </Link>
      </section>
      <LanguageChoice className="user-language" />
    </>
  );
};
