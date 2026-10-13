import { Heading, Link, Paragraph, Tag } from '@digdir/designsystemet-react';
import type { VariantSpec } from '../../data/service-definition';
import { strategyFor } from '../../data/strategies';
import { useT } from '../../i18n';

const publicNameOf = (service: string, v: VariantSpec, index: number, first: string) =>
  (index === 0 ? first : v.publicName) || `${service}__${v.id}`;

interface Props {
  service: string;
  publicName: string;
  variants: VariantSpec[] | undefined;
}

export const VariantsList = ({ service, publicName, variants }: Props) => {
  const t = useT();
  const list: VariantSpec[] = variants?.length ? variants : [{ id: 'default' }];
  return (
    <section aria-labelledby="variants-list-h" className="stack-sm">
      <Heading level={3} data-size="2xs" id="variants-list-h">
        {t('serviceChannels.modes')}
      </Heading>
      <Paragraph data-size="sm" className="meta">
        {t('serviceChannels.modesHelp')}
      </Paragraph>
      <ul className="plain-list">
        {list.map((v, i) => (
          <li key={v.id} className="row-wrap">
            <Tag data-size="sm" data-color="neutral">
              {i === 0 ? t('serviceChannels.modesDefault') : v.id}
            </Tag>
            <code>{publicNameOf(service, v, i, publicName)}</code>
            {v.strategy ? (
              <span className="meta">
                {t('serviceChannels.modesOwnWay', {
                  name: strategyFor(v.strategy.id, t)?.name ?? v.strategy.id,
                })}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <Link href={`#/services/${encodeURIComponent(service)}/setup/variants`}>
        {t('serviceChannels.modesEdit')}
      </Link>
    </section>
  );
};
