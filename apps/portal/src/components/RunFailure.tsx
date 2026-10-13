import {
  Alert,
  Button,
  Details,
  DetailsContent,
  DetailsSummary,
  Heading,
  Link,
  Paragraph,
} from '@digdir/designsystemet-react';
import { useT, type PlainKey, type T } from '../i18n';

export interface RunFailureInfo {
  code: string;
  title?: string;
  step?: string;
  detail?: string;
  runId?: string;
}

const hints: Record<string, PlainKey> = {
  misconfigured: 'runFailure.hintMisconfigured',
  forbidden: 'runFailure.hintForbidden',
  budget_exceeded: 'runFailure.hintSmaller',
  limit_exceeded: 'runFailure.hintSmaller',
  deadline_exceeded: 'runFailure.hintDeadline',
};

export const isModelFailure = (failure: Pick<RunFailureInfo, 'code'>) =>
  failure.code === 'model_error';

const splitTitle = (failure: RunFailureInfo, t: T) => {
  const title = failure.title ?? t('runFailure.defaultTitle');
  const lead = failure.step ? t('runFailure.stepFailed', { step: failure.step }) : '';
  return lead && title.startsWith(lead)
    ? { lead, rest: title.slice(lead.length).trim() }
    : { lead, rest: title };
};

export const logHref = (runId: string) => `#/log/${encodeURIComponent(runId)}`;

export const RunFailure = ({
  failure,
  onRetry,
  busy = false,
}: {
  failure: RunFailureInfo;
  onRetry?: () => void;
  busy?: boolean;
}) => {
  const t = useT();
  const { lead, rest } = splitTitle(failure, t);
  const hintKey = hints[failure.code];
  return (
    <div className="stack-sm">
      <Alert data-color="danger">
        <Heading level={3} data-size="2xs">
          {t('runFailure.heading')}
        </Heading>
        <Paragraph>
          {lead ? <strong>{lead}</strong> : null}
          {lead && rest ? ' ' : null}
          {rest}
        </Paragraph>
        {hintKey ? <Paragraph>{t(hintKey)}</Paragraph> : null}
      </Alert>
      {failure.detail ? (
        <Details>
          <DetailsSummary>{t('runFailure.technical')}</DetailsSummary>
          <DetailsContent>
            <pre className="run-failure-detail">
              {[
                ...(failure.step ? [`step: ${failure.step}`] : []),
                `error: ${failure.code}`,
                `message: ${failure.detail}`,
                ...(failure.runId ? [`run: ${failure.runId}`] : []),
              ].join('\n')}
            </pre>
          </DetailsContent>
        </Details>
      ) : null}
      <div className="actions">
        {onRetry ? (
          <Button
            variant="secondary"
            data-size="sm"
            aria-disabled={busy ? true : undefined}
            onClick={onRetry}
          >
            {t('common.tryAgain')}
          </Button>
        ) : null}
        {failure.runId ? (
          <Link href={logHref(failure.runId)}>{t('runFailure.seeInLog')}</Link>
        ) : null}
      </div>
    </div>
  );
};

export const ModelNoAnswer = ({
  text,
  onRetry,
  busy = false,
}: {
  text: string;
  onRetry?: () => void;
  busy?: boolean;
}) => {
  const t = useT();
  return (
    <Alert data-color="warning">
      <Heading level={3} data-size="2xs">
        {t('runFailure.noAnswer')}
      </Heading>
      <Paragraph>{text}</Paragraph>
      {onRetry ? (
        <Button
          variant="secondary"
          data-size="sm"
          aria-disabled={busy ? true : undefined}
          onClick={onRetry}
        >
          {t('common.tryAgain')}
        </Button>
      ) : null}
    </Alert>
  );
};
