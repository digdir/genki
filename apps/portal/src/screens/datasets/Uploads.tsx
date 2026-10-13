import { Alert, Button, Heading, Paragraph, Spinner, Tag } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useRef, useState } from 'react';
import type { ApiClient } from '../../api';
import { useAsync } from '../../hooks';
import { useT, type PlainKey } from '../../i18n';
import { ErrorState, Loading } from '../../states';
import { FilePicker } from './FilePicker';
import { failureText, fileProblem, reasonText, sizeText } from './live-model';

type Progress =
  | { state: 'waiting' }
  | { state: 'uploading' }
  | { state: 'done' }
  | { state: 'skipped'; why: string }
  | { state: 'failed'; why: string };

interface Item {
  key: string;
  name: string;
  size: number;
  progress: Progress;
}

const progressTag: Record<
  Progress['state'],
  { text: PlainKey; color: 'info' | 'success' | 'warning' | 'danger' | 'neutral' }
> = {
  waiting: { text: 'datasets.uploadWaiting', color: 'neutral' },
  uploading: { text: 'datasets.uploadUploading', color: 'info' },
  done: { text: 'datasets.uploadDone', color: 'success' },
  skipped: { text: 'datasets.uploadSkipped', color: 'warning' },
  failed: { text: 'datasets.statusFailed', color: 'danger' },
};

export const Uploads = ({
  api,
  tenant,
  dataset,
  datasetName,
  canEdit,
  onUploaded,
}: {
  api: ApiClient;
  tenant: string;
  dataset: string;
  datasetName: string;
  canEdit: boolean;
  onUploaded: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const tRef = useRef(t);
  tRef.current = t;
  const [list, retry] = useAsync(
    (signal) => api.datasets.uploads(tenant, dataset, signal),
    [api, tenant, dataset],
  );
  const [items, setItems] = useState<Item[]>([]);
  const [removing, setRemoving] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();

  const patch = (key: string, progress: Progress) =>
    setItems((all) => all.map((i) => (i.key === key ? { ...i, progress } : i)));

  const upload = async (files: File[]) => {
    setMessage(undefined);
    const stamp = Date.now();
    const queued = files.map((file, i) => {
      const problem = fileProblem(t, file);
      return {
        file,
        item: {
          key: `${stamp}-${i}`,
          name: file.name,
          size: file.size,
          progress: problem
            ? ({ state: 'skipped', why: problem } as const)
            : ({ state: 'waiting' } as const),
        },
      };
    });
    setItems((all) => [...queued.map((q) => q.item), ...all]);
    let stored = 0;
    for (const { file, item } of queued) {
      if (item.progress.state !== 'waiting') continue;
      patch(item.key, { state: 'uploading' });
      try {
        const result = await api.datasets.upload(
          tenant,
          dataset,
          [file],
          `Lastet opp ${file.name} til ${datasetName}`,
        );
        const skipped = result.skipped.find((s) => s.name === file.name);
        if (skipped)
          patch(item.key, { state: 'skipped', why: reasonText(tRef.current, skipped.reason) });
        else {
          stored += 1;
          patch(item.key, { state: 'done' });
        }
      } catch (error) {
        patch(item.key, { state: 'failed', why: failureText(tRef.current, error) });
      }
    }
    if (stored > 0) {
      retry();
      onUploaded();
    }
  };

  const remove = async (name: string) => {
    setRemoving(name);
    setMessage(undefined);
    try {
      await api.datasets.removeUpload(tenant, dataset, name, `Slettet ${name} fra ${datasetName}`);
      setMessage({
        ok: true,
        text: tRef.current('datasets.fileDeleted', { name }),
      });
      retry();
    } catch (error) {
      setMessage({
        ok: false,
        text: tRef.current('datasets.fileDeleteFailed', {
          name,
          problem: failureText(tRef.current, error),
        }),
      });
    } finally {
      setRemoving('');
    }
  };

  return (
    <section aria-labelledby="filer-h" className="source-card uploads">
      <h2 id="filer-h" className="card-title">
        {t('datasets.files')}
      </h2>
      {canEdit ? (
        <FilePicker
          id="last-opp"
          label={t('datasets.uploadFiles')}
          onFiles={(f) => void upload(f)}
        />
      ) : null}
      {items.length > 0 ? (
        <ul aria-label={t('datasets.uploads')} className="file-list" aria-live="polite">
          {items.map((i) => (
            <li key={i.key}>
              <span className="file-name">
                <strong>{i.name}</strong>
                <span className="meta">{sizeText(t, f, i.size)}</span>
              </span>
              <Tag data-size="sm" data-color={progressTag[i.progress.state].color}>
                {i.progress.state === 'uploading' ? (
                  <Spinner aria-hidden="true" data-size="2xs" />
                ) : null}
                {t(progressTag[i.progress.state].text)}
              </Tag>
              {'why' in i.progress ? <span className="meta wrap">{i.progress.why}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div aria-live="polite">
        {message ? (
          <Alert data-color={message.ok ? 'success' : 'danger'} data-size="sm">
            {message.text}
          </Alert>
        ) : null}
      </div>
      <Heading level={3} data-size="2xs">
        {t('datasets.uploadedFiles')}
      </Heading>
      {list.status === 'loading' ? <Loading label={t('datasets.loadingFiles')} /> : null}
      {list.status === 'error' ? (
        <ErrorState error={list.error} onRetry={retry} headingLevel={4} />
      ) : null}
      {list.status === 'ready' && list.data.length === 0 ? (
        <Paragraph data-size="sm" className="meta">
          {t('datasets.noFiles')}
        </Paragraph>
      ) : null}
      {list.status === 'ready' && list.data.length > 0 ? (
        <ul aria-label={t('datasets.uploadedFiles')} className="file-list">
          {list.data.map((file) => (
            <li key={file.name}>
              <span className="file-name">
                <strong>{file.name}</strong>
                <span className="meta">{sizeText(t, f, file.size)}</span>
              </span>
              {canEdit ? (
                <Button
                  variant="tertiary"
                  data-size="sm"
                  aria-label={t('datasets.deleteFile', { name: file.name })}
                  aria-disabled={removing ? true : undefined}
                  onClick={() => !removing && void remove(file.name)}
                >
                  {removing === file.name ? t('datasets.deleting') : t('common.delete')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
};
