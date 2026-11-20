import { Alert, Button, Heading, Paragraph } from '@digdir/designsystemet-react';
import { useEffect, useState } from 'react';
import { useT, type PlainKey } from '../../i18n';
import { forgetHandover, handoverFor, type HandoverItem } from './handover';

const itemKeys: Record<HandoverItem, PlainKey> = {
  layout: 'playground.handoverLayout',
  model: 'playground.handoverModel',
  instructions: 'playground.handoverInstructions',
  datasets: 'playground.handoverDatasets',
  skills: 'playground.handoverSkills',
  blocks: 'playground.handoverBlocks',
  output: 'playground.handoverOutput',
  answerLanguage: 'playground.handoverAnswerLanguage',
  compare: 'playground.handoverCompare',
  startService: 'playground.handoverStartService',
  conversation: 'playground.handoverConversation',
};

/**
 * Says once, on the new service the playground made, what it carried over and what it did not.
 * It is said on this visit only: leaving the service or closing the notice forgets it.
 */
export const HandoverNotice = ({ draft }: { draft: string }) => {
  const t = useT();
  const [handover, setHandover] = useState(() => handoverFor(draft));
  useEffect(() => () => forgetHandover(draft), [draft]);
  if (!handover) return null;
  const list = (items: readonly HandoverItem[]) => (
    <ul className="bullets">
      {items.map((item) => (
        <li key={item}>{t(itemKeys[item])}</li>
      ))}
    </ul>
  );
  return (
    <Alert data-color="info" data-size="sm">
      <Heading level={2} data-size="2xs">
        {t('playground.handoverTitle')}
      </Heading>
      <Paragraph data-size="sm">{t('playground.handoverCarried')}</Paragraph>
      {list(handover.carried)}
      {handover.left.length ? (
        <>
          <Paragraph data-size="sm">{t('playground.handoverLeft')}</Paragraph>
          {list(handover.left)}
        </>
      ) : null}
      <Button
        variant="tertiary"
        data-size="sm"
        onClick={() => {
          forgetHandover(draft);
          setHandover(undefined);
        }}
      >
        {t('playground.handoverClose')}
      </Button>
    </Alert>
  );
};
