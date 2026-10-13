import { Label } from '@digdir/designsystemet-react';
import { useState, type DragEvent } from 'react';
import { useT } from '../../i18n';
import { uploadAccept } from './live-model';

export const FilePicker = ({
  id,
  label,
  onFiles,
}: {
  id: string;
  label?: string;
  onFiles: (files: File[]) => void;
}) => {
  const t = useT();
  const [over, setOver] = useState(false);
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setOver(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length) onFiles(files);
  };
  return (
    <div
      id={`${id}-sone`}
      className={over ? 'drop-zone file-picker dragging' : 'drop-zone file-picker'}
      tabIndex={-1}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      <Label htmlFor={id}>{label ?? t('datasets.chooseFiles')}</Label>
      <input
        id={id}
        type="file"
        multiple
        accept={uploadAccept}
        aria-describedby={`${id}-hjelp`}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
      <span id={`${id}-hjelp`} className="meta">
        {t('datasets.dropHelp')}
      </span>
    </div>
  );
};
