import { Alert, Heading, Paragraph, Tag } from '@digdir/designsystemet-react';
import { useT } from '../i18n';

/** A first draft of the page the architecture assistant will live on. */
export const ArchitectureAssistant = () => {
  const t = useT();
  return (
    <div className="stack">
      <div className="page-head">
        <div className="page-head-text">
          <div className="row-wrap">
            <Heading level={1} data-size="lg">
              {t('architecture.title')}
            </Heading>
            <Tag data-color="warning" data-size="sm">
              {t('architecture.draftTag')}
            </Tag>
          </div>
          <p className="lead">{t('architecture.lead')}</p>
        </div>
      </div>
      <Alert data-color="info" data-size="sm">
        <Heading level={2} data-size="2xs">
          {t('architecture.draftTitle')}
        </Heading>
        <Paragraph data-size="sm">{t('architecture.draft')}</Paragraph>
      </Alert>
    </div>
  );
};
