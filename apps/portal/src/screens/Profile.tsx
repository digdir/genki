import { Fieldset, Heading, Link, Radio } from '@digdir/designsystemet-react';
import { LanguageChoice } from '@genai/i18n/react';
import { useEffect, useId, useState } from 'react';
import { formatOrgNumber } from '../data/organisations';
import { useT, type PlainKey } from '../i18n';
import { rightLabel, useRights, useUserName } from '../Shell';
import { saveTheme, storedTheme, type Theme } from '../theme';
import type { PortalRight } from '../types';

const rightLines: Record<PortalRight, PlainKey> = {
  'use-services': 'profile.useServicesLine',
  'manage-services': 'profile.manageServicesLine',
  'manage-datasets': 'profile.manageDatasetsLine',
  'register-building-blocks': 'profile.registerBuildingBlocksLine',
  'view-usage': 'profile.viewUsageLine',
};

const themeLabels: [Theme, PlainKey][] = [
  ['light', 'profile.themeLight'],
  ['dark', 'profile.themeDark'],
  ['auto', 'profile.themeAuto'],
];

const useSavedFlash = () => {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(false), 3000);
    return () => clearTimeout(timer);
  }, [shown]);
  return [shown, () => setShown(true)] as const;
};

export const Profile = ({ tenant, tenantName }: { tenant: string; tenantName: string }) => {
  const t = useT();
  const name = useUserName();
  const { rights } = useRights();
  const themeName = useId();
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [themeSaved, flashTheme] = useSavedFlash();
  const [themeFailed, setThemeFailed] = useState(false);
  const [languageSaved, flashLanguage] = useSavedFlash();
  return (
    <div className="stack profile">
      <Heading level={1} data-size="lg">
        {t('shell.menuProfile')}
      </Heading>
      <dl className="profile-facts">
        <div>
          <dt>{t('profile.name')}</dt>
          <dd>{name}</dd>
        </div>
        <div>
          <dt>{t('profile.actingFor')}</dt>
          <dd>{t('profile.organisation', { name: tenantName, orgNr: formatOrgNumber(tenant) })}</dd>
        </div>
      </dl>
      <section aria-labelledby="rights-h" className="stack-sm">
        <Heading level={2} data-size="xs" id="rights-h">
          {t('shell.yourRights')}
        </Heading>
        <p className="meta">{t('shell.rightsGivenBy')}</p>
        {rights.length > 0 ? (
          <ul className="profile-rights">
            {rights.map((r) => (
              <li key={r}>
                <span className="profile-right">{rightLabel(t, r)}</span>
                <span className="meta">{t(rightLines[r])}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>{t('profile.noRights', { name: tenantName })}</p>
        )}
        <Link href="https://www.altinn.no" target="_blank" rel="noopener">
          {t('shell.seeInAltinn')}
        </Link>
      </section>
      <section aria-labelledby="language-h" className="stack-sm">
        <Heading level={2} data-size="xs" id="language-h">
          {t('profile.language')}
        </Heading>
        <LanguageChoice className="user-language" onChange={flashLanguage} />
        <span role="status" className="profile-saved">
          {languageSaved ? t('profile.savedHere') : ''}
        </span>
      </section>
      <section aria-labelledby="theme-h" className="stack-sm">
        <Heading level={2} data-size="xs" id="theme-h">
          {t('profile.theme')}
        </Heading>
        <Fieldset data-size="sm">
          <Fieldset.Legend>{t('profile.themeLegend')}</Fieldset.Legend>
          {themeLabels.map(([value, label]) => (
            <Radio
              key={value}
              name={themeName}
              value={value}
              label={t(label)}
              checked={theme === value}
              onChange={() => {
                setTheme(value);
                const stored = saveTheme(value);
                setThemeFailed(!stored);
                if (stored) flashTheme();
              }}
            />
          ))}
        </Fieldset>
        <span role="status" className="profile-saved">
          {themeFailed ? t('profile.notStored') : themeSaved ? t('profile.savedHere') : ''}
        </span>
      </section>
    </div>
  );
};
