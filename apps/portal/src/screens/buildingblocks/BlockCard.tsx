import { Tag } from '@digdir/designsystemet-react';
import { blockHref, type CatalogItem } from '../../api/building-blocks';
import { DataLocationTag } from '../../components/DataLocationTag';
import { statusLabels } from '../../data/building-blocks';
import { useT } from '../../i18n';
import { judgeRefusalText, serviceName, usedText, versionText } from './common';

export const BlockCard = ({ item }: { item: CatalogItem }) => {
  const t = useT();
  const status = statusLabels[item.status];
  const first = item.update?.perService[0];
  return (
    <li className="bb-card">
      <div className="bb-card-head">
        <a className="bb-card-name" href={blockHref(item)}>
          {item.name}
        </a>
        <Tag data-size="sm" data-color={status.color}>
          {t(status.label)}
        </Tag>
      </div>
      <span className="bb-card-desc">{item.description}</span>
      <div className="tag-row">
        {item.dataLocation ? <DataLocationTag location={item.dataLocation} /> : null}
        {item.isNew ? (
          <Tag data-size="sm" data-color="info">
            {t('blocks.new')}
          </Tag>
        ) : null}
      </div>
      <span className="bb-meta">
        {item.publisher.name} · {versionText(t, item)} · {usedText(t, item)}
      </span>
      {item.update && item.status === 'in_use' && first ? (
        <div className="bb-card-update">
          <Tag data-size="sm" data-color="info">
            {t('blocks.updateAvailable')}
          </Tag>
          <span>
            {t('blocks.versionCap', { version: item.update.version })}
            {first.scoreBefore !== null && first.scoreAfter !== null
              ? ` · ${t('blocks.scoreChange', {
                  before: first.scoreBefore,
                  after: first.scoreAfter,
                  service: serviceName(item.usedBy, first.service),
                })}`
              : ''}
          </span>
        </div>
      ) : null}
      {item.status === 'not_allowed' && item.policyBlock ? (
        <span className="bb-block-text">
          {item.judge?.refused ? judgeRefusalText(t, item.judge.refused) : item.policyBlock.text}
        </span>
      ) : null}
    </li>
  );
};
