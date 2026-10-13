import { Details, DetailsContent, DetailsSummary } from '@digdir/designsystemet-react';
import { useT } from './i18n';
import { NotDecided } from './ui';

export const ApiCall = ({
  method,
  path,
  body,
  proposed = false,
}: {
  method: string;
  path: string;
  body?: unknown;
  proposed?: boolean;
}) => {
  const t = useT();
  return (
    <Details className="api-call">
      <DetailsSummary>{t('common.showApiCall')}</DetailsSummary>
      <DetailsContent>
        <div className="stack-sm">
          {proposed ? (
            <span className="tag-line">
              <NotDecided />
              {t('common.proposedCall')}
            </span>
          ) : null}
          <code className="api-line">{`${method} ${path}`}</code>
          {body === undefined ? null : <pre className="code">{JSON.stringify(body, null, 2)}</pre>}
        </div>
      </DetailsContent>
    </Details>
  );
};
