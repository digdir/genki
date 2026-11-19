import { Heading, List, Paragraph } from '@digdir/designsystemet-react';
import { dataHandlingPath } from '../../data/data-handling';
import { useT } from '../../i18n';
import { useDocumentTitle } from './public-pages';

export const PricePage = () => {
  const t = useT();
  useDocumentTitle(t('about.priceTitle'));
  return (
    <div className="about-prose">
      <div className="stack">
        <Heading level={1} data-size="lg">
          {t('about.priceTitle')}
        </Heading>
        <Paragraph className="lede">{t('about.priceLede')}</Paragraph>
      </div>
      <section aria-labelledby="price-usage-h" className="about-prose-section">
        <Heading level={2} data-size="sm" id="price-usage-h">
          {t('about.priceUsageHeading')}
        </Heading>
        <Paragraph>{t('about.priceUsage1')}</Paragraph>
        <Paragraph>{t('about.priceUsage2')}</Paragraph>
      </section>
      <section aria-labelledby="price-free-h" className="about-prose-section">
        <Heading level={2} data-size="sm" id="price-free-h">
          {t('about.priceFreeHeading')}
        </Heading>
        <List.Unordered>
          <List.Item>{t('about.priceFree1')}</List.Item>
          <List.Item>{t('about.priceFree2')}</List.Item>
          <List.Item>{t('about.priceFree3')}</List.Item>
        </List.Unordered>
      </section>
      <section aria-labelledby="price-terms-h" className="about-prose-section">
        <Heading level={2} data-size="sm" id="price-terms-h">
          {t('about.priceTermsHeading')}
        </Heading>
        <Paragraph>
          {t.rich('about.priceTerms', { link: (c) => <a href={dataHandlingPath}>{c}</a> })}
        </Paragraph>
      </section>
    </div>
  );
};
