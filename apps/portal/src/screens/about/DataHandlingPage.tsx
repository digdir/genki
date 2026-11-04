import { useT } from '../../i18n';
import { DataHandlingContent } from '../DataHandling';
import { useDocumentTitle } from './public-pages';

export const DataHandlingPage = () => {
  const t = useT();
  useDocumentTitle(t('dataHandling.title'));
  return (
    <div className="about-prose">
      <DataHandlingContent />
    </div>
  );
};
