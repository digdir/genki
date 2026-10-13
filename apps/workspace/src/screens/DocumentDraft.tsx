import { Button, Heading, Paragraph } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useT } from '../i18n';
import { provenanceFooter, provenanceOf, textOf } from '../provenance';
import type { DocumentDraft as Draft } from '../types';

interface Props {
  draft: Draft;
  onDownload: () => void;
  onGoToApprovals: () => void;
}

const PenIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    aria-hidden="true"
  >
    <path d="M4 20h4L19 9l-4-4L4 16z" />
  </svg>
);

export const DocumentDraft = ({ draft, onDownload, onGoToApprovals }: Props) => {
  const t = useT();
  const f = useFormat();
  const provenance = provenanceOf(draft.parts);
  const createdAt = new Date(draft.createdAt);
  const [first = '', ...rest] = textOf(draft.parts);
  const heading = first.startsWith('# ') ? first.slice(2) : undefined;
  const paragraphs = (heading ? rest : [first, ...rest]).flatMap((p) => p.split(/\n{2,}/));
  const labelled = !provenance?.approved;

  return (
    <div className="document">
      <Paragraph>{t('document.intro')}</Paragraph>
      <article aria-labelledby="document-heading" className="document-sheet">
        {labelled ? (
          <div role="note" className="document-banner">
            <PenIcon />
            <strong>{t('document.aiDraft')}</strong>
            <span>{t('document.bannerText')}</span>
          </div>
        ) : null}
        <div className="document-body">
          <span className="subtle-sm">
            {t('document.meta', {
              agency: draft.agency,
              caseNumber: draft.caseNumber,
              date: f.date(createdAt),
            })}
          </span>
          <Heading level={2} data-size="sm" id="document-heading">
            {heading ?? t('document.fallbackHeading')}
          </Heading>
          {paragraphs.map((p, i) => (
            <p key={i} className="document-paragraph">
              {p}
            </p>
          ))}
        </div>
        <footer className="document-footer">
          {provenance
            ? provenanceFooter(
                provenance,
                {
                  serviceName: draft.serviceName,
                  createdAt,
                  sourceLabels: draft.sourceLabels,
                },
                t,
                f,
              )
            : t('document.noProvenance')}
        </footer>
      </article>
      <div className="actions">
        <Button variant="secondary" onClick={onDownload}>
          {t('document.download')}
        </Button>
        <Button variant="tertiary" onClick={onGoToApprovals}>
          {t('document.goToApprovals')}
        </Button>
      </div>
    </div>
  );
};
