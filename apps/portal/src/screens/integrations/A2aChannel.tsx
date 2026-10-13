import { Field, Input, Label, Paragraph, Tag } from '@digdir/designsystemet-react';
import { useId } from 'react';
import { useT } from '../../i18n';
import { CopyButton } from '../../components/CopyButton';
import { publicApiBase } from '../../public-api';
import './a2a-channel.css';

export const agentCardAddress = (publicName: string, apiBase = publicApiBase) =>
  `${apiBase}/a2a/${encodeURIComponent(publicName)}/.well-known/agent-card.json`;

export const A2aChannel = ({
  name,
  purpose,
  publicName,
  hasInputForm,
  apiBase = publicApiBase,
}: {
  name: string;
  purpose: string;
  publicName: string;
  hasInputForm: boolean;
  apiBase?: string;
}) => {
  const t = useT();
  const id = useId();
  const address = publicName ? agentCardAddress(publicName, apiBase) : '';
  return (
    <div className="a2a-channel">
      <Paragraph data-size="sm">{t('integA2a.intro')}</Paragraph>
      {address ? (
        <Field>
          <Label htmlFor={id}>{t('integA2a.cardAddress')}</Label>
          <div className="a2a-channel-address">
            <Input id={id} readOnly value={address} />
            <CopyButton text={address} />
          </div>
        </Field>
      ) : (
        <Paragraph data-size="sm">{t('integA2a.cardAddressLater')}</Paragraph>
      )}
      <dl className="a2a-channel-dl">
        <dt>{t('integA2a.skill')}</dt>
        <dd>
          {name}
          {purpose
            ? `: ${purpose.charAt(0).toLowerCase()}${purpose.slice(1).replace(/\.$/, '')}`
            : ''}
        </dd>
        <dt>{t('integA2a.input')}</dt>
        <dd>{t(hasInputForm ? 'integA2a.inputWithForm' : 'integA2a.inputText')}</dd>
        <dt>{t('integA2a.output')}</dt>
        <dd>{t('integA2a.outputValue')}</dd>
        <dt>{t('integrations.login')}</dt>
        <dd className="a2a-channel-auth">
          {t('integA2a.authNow')}{' '}
          <Tag data-color="warning" data-size="sm">
            {t('integA2a.undecided')}
          </Tag>
        </dd>
      </dl>
    </div>
  );
};
