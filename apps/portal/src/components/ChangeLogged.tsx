import { createFormat, type Format } from '@genai/i18n';
import { Alert, Paragraph } from '@digdir/designsystemet-react';
import type { ReactNode } from 'react';
import { usePortalFormat } from '../format';
import { translator, type T } from '../i18n';

const nbFormat = createFormat('nb');
const nbT = translator('nb');

const osloDay = (at: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo' }).format(at);

export const changedWhen = (at: Date, now = new Date(), f: Format = nbFormat, t: T = nbT) =>
  osloDay(at) === osloDay(now)
    ? t('components.todayAt', { time: f.time(at) })
    : f.dateTime(at, 'long');

export const ChangeLogged = ({
  by,
  at,
  reason,
  children,
  now,
}: {
  by: string;
  at: Date | string;
  reason: string;
  children?: ReactNode;
  now?: Date;
}) => {
  const { f, t } = usePortalFormat();
  return (
    <Alert data-color="success" data-size="sm" role="status">
      <Paragraph data-size="sm">
        {children ? <>{children} </> : null}
        {t('components.changeLogged', {
          by,
          when: changedWhen(new Date(at), now, f, t),
          reason: reason.trim(),
        })}
      </Paragraph>
    </Alert>
  );
};
