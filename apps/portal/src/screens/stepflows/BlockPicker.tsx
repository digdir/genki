import { Button, Dialog, Heading, Paragraph, Textfield } from '@digdir/designsystemet-react';
import { useState } from 'react';
import { blocks } from '../../data/stepflows';
import { useT } from '../../i18n';

export const BlockPicker = ({
  onPick,
  onClose,
}: {
  onPick: (block: string) => void;
  onClose: () => void;
}) => {
  const t = useT();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const found = Object.entries(blocks).filter(
    ([id, b]) => !q || `${id} ${b.name} ${b.desc ?? ''}`.toLowerCase().includes(q),
  );
  return (
    <Dialog
      open
      modal
      closeButton={false}
      onClose={onClose}
      aria-labelledby="block-picker-h"
      className="block-picker"
    >
      <div className="stack-sm">
        <Heading level={2} data-size="xs" id="block-picker-h">
          {t('stepflows.addStep')}
        </Heading>
        <Textfield
          id="block-picker-q"
          label={t('stepflows.search')}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {found.length ? (
          <ul className="block-picker-list" aria-label={t('stepflows.blocksLabel')}>
            {found.map(([id, b]) => (
              <li key={id}>
                <button type="button" className="block-picker-item" onClick={() => onPick(id)}>
                  <span className="row-wrap">
                    <span className="flow-label">{b.name}</span>
                    <code className="meta">
                      {id}@{b.version ?? '1'}
                    </code>
                  </span>
                  {b.desc ? <span className="meta">{b.desc}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <Paragraph data-size="sm">{t('stepflows.noBlocks', { query: query.trim() })}</Paragraph>
        )}
        <div>
          <Button variant="secondary" onClick={onClose}>
            {t('stepflows.close')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};
