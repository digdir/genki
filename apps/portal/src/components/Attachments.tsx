import { Link } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useState } from 'react';
import { useT, type Format, type T } from '../i18n';

export interface AttachmentView {
  id: string;
  mediaType: string;
  bytes: number;
  step?: string | undefined;
  url: string;
}

export type LoadMedia = (url: string, signal: AbortSignal) => Promise<Blob>;

export const mediaUrl = (task: string, id: string) =>
  `/v1/tasks/${encodeURIComponent(task)}/media/${encodeURIComponent(id)}`;

export const sizeText = (bytes: number, t: T, f: Format) =>
  bytes < 1024
    ? t('components.bytes', { n: f.number(bytes) })
    : bytes < 1024 * 1024
      ? t('components.kilobytes', { n: f.number(Math.round(bytes / 102.4) / 10) })
      : t('components.megabytes', { n: f.number(Math.round(bytes / 104857.6) / 10) });

type Loaded = { status: 'loading' } | { status: 'ready'; src: string } | { status: 'failed' };

const objectUrl = (blob: Blob) =>
  typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : undefined;

export const AttachmentCard = ({ item, load }: { item: AttachmentView; load: LoadMedia }) => {
  const t = useT();
  const f = useFormat();
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    let src: string | undefined;
    load(item.url, controller.signal).then(
      (blob) => {
        src = objectUrl(blob);
        if (!controller.signal.aborted)
          setLoaded(src ? { status: 'ready', src } : { status: 'failed' });
      },
      () => !controller.signal.aborted && setLoaded({ status: 'failed' }),
    );
    return () => {
      controller.abort();
      if (src) URL.revokeObjectURL(src);
    };
  }, [item.url, load]);
  const kind = item.mediaType.split('/')[0];
  const meta = [
    t('components.attachmentMeta', {
      mediaType: item.mediaType,
      size: sizeText(item.bytes, t, f),
    }),
    ...(item.step ? [t('components.attachmentFromStep', { step: item.step })] : []),
  ].join(' · ');
  return (
    <figure className="attachment-card">
      {loaded.status === 'ready' ? (
        kind === 'image' ? (
          <img
            src={loaded.src}
            alt={
              item.step
                ? t('components.attachmentImage', { step: item.step })
                : t('components.attachmentImagePlain')
            }
          />
        ) : kind === 'audio' ? (
          <audio controls src={loaded.src} />
        ) : kind === 'video' ? (
          <video controls src={loaded.src} />
        ) : null
      ) : (
        <p className="meta" role={loaded.status === 'failed' ? 'alert' : undefined}>
          {loaded.status === 'loading'
            ? t('components.attachmentLoading')
            : t('components.attachmentFailed')}
        </p>
      )}
      <figcaption className="meta">
        {meta}
        {loaded.status === 'ready' ? (
          <>
            {' · '}
            <Link
              href={loaded.src}
              download={`${item.id}.${item.mediaType.split('/')[1] ?? 'bin'}`}
            >
              {t('components.attachmentOpen')}
            </Link>
          </>
        ) : null}
      </figcaption>
    </figure>
  );
};

export const Attachments = ({ items, load }: { items: AttachmentView[]; load: LoadMedia }) => {
  const t = useT();
  return items.length ? (
    <section className="attachments" aria-label={t('components.attachmentsLabel')}>
      {items.map((item) => (
        <AttachmentCard key={`${item.url}`} item={item} load={load} />
      ))}
    </section>
  ) : null;
};
