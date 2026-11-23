import { Link } from '@digdir/designsystemet-react';
import { ExternalLinkIcon } from '@navikt/aksel-icons';
import { classes } from '../dom.js';
import { useMedia } from '../shell/hooks.js';
import { useT } from './i18n.js';

const SMALL_SCREEN = '(width < 40rem), (height < 30rem)';

export interface PdfViewProps {
  url: string;
  title: string;
  className?: string | undefined;
}

export const PdfView = ({ url, title, className }: PdfViewProps) => {
  const t = useT();
  const smallScreen = useMedia(SMALL_SCREEN);
  const inline =
    !smallScreen && !(typeof navigator !== 'undefined' && navigator.pdfViewerEnabled === false);
  return inline ? (
    <iframe
      key={url}
      className={classes('uib-document-view-file', className)}
      src={url}
      title={t('documentView.fileTitle', { title })}
    />
  ) : (
    <Link
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      data-size="sm"
      className={classes('uib-document-view-link', className)}
      aria-label={`${t('documentView.openFile')}, ${title} ${t('sources.opensInNewTab')}`}
    >
      <span>{t('documentView.openFile')}</span>
      <ExternalLinkIcon aria-hidden />
    </Link>
  );
};
