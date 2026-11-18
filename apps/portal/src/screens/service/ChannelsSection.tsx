import { Heading, Paragraph } from '@digdir/designsystemet-react';
import type { ReactNode } from 'react';
import { usePortalFormat } from '../../format';

export const ChannelsSection = ({
  live,
  modes,
  editor,
}: {
  live?: ReactNode;
  modes: ReactNode;
  editor: ReactNode;
}) => {
  const { t } = usePortalFormat();
  return (
    <div className="stack">
      <div className="stack-xs">
        <Heading level={2} data-size="xs">
          {t('service.sectionChannels')}
        </Heading>
        <Paragraph data-size="sm" className="meta">
          {t('serviceDev.channelsLead')}
        </Paragraph>
      </div>
      {live}
      {modes}
      {editor}
    </div>
  );
};
