import { Heading, List, Paragraph } from '@digdir/designsystemet-react';
import { NotDecided } from '../../components/NotDecided';
import { dataHandlingPath } from '../../data/data-handling';
import { terms } from '../../data/startside';
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
      <section aria-labelledby="pris-h" className="about-prose-section">
        <Heading level={2} data-size="sm" id="pris-h">
          {t('start.priceHeading')} <NotDecided />
        </Heading>
        <Paragraph>{t('start.priceLead')}</Paragraph>
        <Paragraph>{t('start.pricesNotDecided')}</Paragraph>
        <Paragraph>{t('start.priceQuota')}</Paragraph>
      </section>
      <section aria-labelledby="vilkar-h" className="about-prose-section">
        <Heading level={2} data-size="sm" id="vilkar-h">
          {t('start.termsHeading')} <NotDecided />
        </Heading>
        <List.Unordered>
          {terms.map((term) => (
            <List.Item key={term}>{t(term)}</List.Item>
          ))}
        </List.Unordered>
      </section>
      <a href={dataHandlingPath}>{t('about.priceDataLink')}</a>
    </div>
  );
};
