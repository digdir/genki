import { Heading, Paragraph } from '@digdir/designsystemet-react';
import type { ReactNode } from 'react';
import { usePortalFormat } from '../../format';

export type VersionsView = 'history' | 'yaml';

export const VersionsSection = ({
  view,
  history,
  yaml,
  showHistory,
}: {
  view: VersionsView;
  onView: (view: VersionsView) => void;
  history: ReactNode;
  yaml: ReactNode;
  showHistory: boolean;
}) => {
  const { t } = usePortalFormat();
  if (view !== 'yaml' && showHistory) return <>{history}</>;
  return (
    <div className="stack">
      <div className="stack-xs">
        <Heading level={2} data-size="xs">
          {t('service.sectionDefinition')}
        </Heading>
        <Paragraph data-size="sm" className="meta">
          {t('serviceDev.definitionLead')}
        </Paragraph>
      </div>
      {yaml}
    </div>
  );
};
