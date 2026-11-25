import { Heading, Paragraph, Tag } from '@digdir/designsystemet-react';
import type { BlockDetail } from '@genai/contracts/blocks';
import { useLocale } from '@genai/i18n/react';
import type { ReactNode } from 'react';
import { useT } from '../../i18n';
import { originColor, titleOf, versionName, zoneKey } from './naming';

export const Crumbs = ({ items }: { items: { label: string; href?: string }[] }) => {
  const t = useT();
  return (
    <nav aria-label={t('components.breadcrumbs')} className="design-crumbs">
      {items.map((item, i) => (
        <span key={item.label}>
          {i > 0 ? <span aria-hidden="true">/</span> : null}
          {item.href ? <a href={item.href}>{item.label}</a> : <span>{item.label}</span>}
        </span>
      ))}
    </nav>
  );
};

export const Panel = ({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) => (
  <section className="design-panel" aria-label={title}>
    <div className="design-panel-head">
      <Heading level={2} data-size="2xs">
        {title}
      </Heading>
      {aside}
    </div>
    {children}
  </section>
);

/** «Publisert av genki», the zones and the version under a block's name; `brief` keeps only the first. */
export const BlockTags = ({ detail, brief = false }: { detail: BlockDetail; brief?: boolean }) => {
  const t = useT();
  return (
    <span className="design-tags">
      <Tag data-size="sm" data-color={originColor[detail.origin]}>
        {t('design.publishedBy', {
          name: detail.origin === 'built-in' ? 'genki' : detail.publisherName,
        })}
      </Tag>
      {brief ? null : (
        <>
          {detail.zones.map((z) => (
            <Tag key={z} data-size="sm" data-color="neutral">
              {t(zoneKey[z])}
            </Tag>
          ))}
          <Tag data-size="sm" data-color="neutral">
            {versionName(t, detail.edition.version)}
          </Tag>
        </>
      )}
    </span>
  );
};

export const Summary = ({ detail }: { detail: BlockDetail }) => {
  const { locale } = useLocale();
  return detail.summary ? (
    <Paragraph data-size="sm" className="meta">
      {titleOf(detail.summary, locale)}
    </Paragraph>
  ) : null;
};

export const Toast = ({ children }: { children: ReactNode }) => (
  <Paragraph role="status" data-size="sm" className="design-toast">
    {children}
  </Paragraph>
);
