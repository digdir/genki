import {
  Avatar,
  Button,
  Field,
  Heading,
  Label,
  Spinner,
  Textarea,
} from '@digdir/designsystemet-react';
import { useEffect, useId, useState } from 'react';
import { Icon, icons } from '../components/Icon';
import { accessManagers } from '../data/access';
import { useT, type PlainKey } from '../i18n';
import type { PortalRight } from '../types';
import { rightLabel } from '../Shell';
import './access.css';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((x) => x[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

const askRights: readonly (readonly [PortalRight, PlainKey])[] = [
  ['use-services', 'noAccess.useDesc'],
  ['manage-services', 'noAccess.servicesDesc'],
  ['manage-datasets', 'noAccess.datasetsDesc'],
  ['view-usage', 'noAccess.usageDesc'],
];

interface Actions {
  onRecheck?: (() => Promise<boolean>) | undefined;
  onSwitchOrg?: (() => void) | undefined;
}

const NoAccessContent = ({
  name,
  organisation,
  live,
  onRecheck,
  onSwitchOrg,
}: {
  name: string;
  organisation: string;
  live: boolean;
} & Actions) => {
  const t = useT();
  const product = t('noAccess.product');
  const messageId = useId();
  const [copied, setCopied] = useState('');
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState('');
  const request = t('noAccess.request', { product, organisation, name });
  useEffect(() => {
    if (!checking || onRecheck) return;
    const timer = setTimeout(() => {
      setChecking(false);
      setCheckMsg(t('noAccess.checkAgain'));
    }, 1200);
    return () => clearTimeout(timer);
  }, [checking]);

  return (
    <div className="no-access">
      <div className="stack-sm">
        <Heading level={1} data-size="lg">
          {t('noAccess.title')}
        </Heading>
        <p className="no-access-intro">{t('noAccess.intro', { name, organisation, product })}</p>
      </div>

      <section aria-labelledby="hvem-h" className="stack-sm">
        <Heading level={2} data-size="xs" id="hvem-h">
          {t('noAccess.whoHeading')}
        </Heading>
        {live ? (
          <p className="body-md">{t('noAccess.whoLive', { organisation })}</p>
        ) : (
          <p className="meta-md">{t('noAccess.whoMock', { organisation })}</p>
        )}
        {live ? null : (
          <ul className="plain-list manager-list">
            {accessManagers.map((m) => (
              <li key={m.email}>
                <Avatar aria-hidden="true">{initials(m.name)}</Avatar>
                <span className="manager-text">
                  <span className="manager-name">{m.name}</span>
                  <span className="meta-md">{m.unit}</span>
                </span>
                <a
                  href={`mailto:${m.email}?subject=${encodeURIComponent(t('noAccess.mailSubject', { product }))}&body=${encodeURIComponent(request)}`}
                  className="manager-mail"
                >
                  {m.email}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="be-h" className="stack-sm">
        <Heading level={2} data-size="xs" id="be-h">
          {t('noAccess.askHeading')}
        </Heading>
        <p className="body-md">{t('noAccess.askMost')}</p>
        <dl className="rights-list">
          {askRights.map(([right, description]) => (
            <div key={right}>
              <dt>{rightLabel(t, right)}</dt>
              <dd>{t(description)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="melding-h" className="stack-sm">
        <Heading level={2} data-size="xs" id="melding-h">
          {t('noAccess.sendHeading')}
        </Heading>
        <Field>
          <Label htmlFor={messageId}>{t('noAccess.suggested')}</Label>
          <Textarea id={messageId} rows={5} readOnly value={request} />
        </Field>
        <div className="actions">
          <Button
            variant="secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(request).catch(() => undefined);
              setCopied(t('noAccess.copied'));
            }}
          >
            {t('noAccess.copyMessage')}
          </Button>
          <span role="status" className="body-md">
            {copied}
          </span>
        </div>
      </section>

      <div className="actions">
        <Button asChild>
          <a href="https://www.altinn.no" target="_blank" rel="noopener">
            {t('noAccess.requestInAltinn')}
            <Icon d={icons.external} size={18} />
            <span className="visually-hidden">{t('noAccess.newTab')}</span>
          </a>
        </Button>
        {onSwitchOrg ? (
          <Button variant="secondary" onClick={onSwitchOrg}>
            {t('noAccess.switchOrg')}
          </Button>
        ) : null}
      </div>

      <div className="recheck">
        <span className="recheck-title">{t('noAccess.justGot')}</span>
        <span className="body-sm">{t('noAccess.mayTake')}</span>
        <div className="actions">
          <Button
            variant="secondary"
            data-size="sm"
            aria-disabled={checking || undefined}
            onClick={() => {
              if (checking) return;
              setCheckMsg(t('noAccess.checking'));
              setChecking(true);
              if (!onRecheck) return;
              void onRecheck()
                .catch(() => false)
                .then((granted) => {
                  if (granted) return;
                  setChecking(false);
                  setCheckMsg(t('noAccess.checkAgain'));
                });
            }}
          >
            {t('noAccess.checkNow')}
          </Button>
          <span role="status" className="recheck-status">
            {checking ? <Spinner aria-hidden="true" data-size="xs" /> : null}
            {checkMsg}
          </span>
        </div>
      </div>
    </div>
  );
};

export const NoAccess = ({
  name,
  organisation,
  embedded = false,
  live = false,
  onLogout,
  onRecheck,
  onSwitchOrg,
}: {
  name: string;
  organisation?: string;
  embedded?: boolean;
  live?: boolean;
  onLogout?: () => void;
} & Actions) => {
  const t = useT();
  const org = organisation ?? (live ? t('noAccess.yourOrg') : 'Testetaten');
  if (embedded) return <NoAccessContent name={name} organisation={org} live={live} />;
  return (
    <div className="shell">
      <header className="header">
        <div className="header-bar">
          <a className="brand" href="#/">
            <img src="/emblem-felleslosning.svg" alt="" width={32} height={32} />
            <span className="brand-text">
              <span className="brand-owner">{t('shell.owner')}</span>
              <span className="brand-name">{t('noAccess.product')}</span>
            </span>
          </a>
          <div className="header-spacer" />
          <Avatar data-size="sm" aria-label={name}>
            {initials(name)}
          </Avatar>
          {onLogout ? (
            <Button variant="tertiary" data-size="sm" onClick={onLogout}>
              {t('shell.logout')}
            </Button>
          ) : null}
        </div>
      </header>
      <main id="hovedinnhold" tabIndex={-1} className="main no-access-main">
        <NoAccessContent
          name={name}
          organisation={org}
          live={live}
          onRecheck={onRecheck}
          onSwitchOrg={onSwitchOrg}
        />
      </main>
    </div>
  );
};
